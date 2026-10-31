import { z } from 'zod'
import { BoundedMap } from '../../shared/bounded-map'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'

const id = z.string().min(1).max(512)
const serviceSchema = z.object({
  name: id,
  state: z.enum(['starting', 'running', 'ready', 'restarting', 'stopping', 'exited', 'failed']),
  pid: z.number().int().positive().optional()
})
const daemonSchema = serviceSchema.extend({
  id,
  startedAt: z.number().finite(),
  exitCode: z.number().int().optional()
})

type Call = { description?: string; nativeAt?: number }
type Service = Call & z.infer<typeof serviceSchema> & { callId: string; ambiguous: boolean }

export class OmpRpcBackgroundServices {
  private readonly services = new Map<string, Service>()
  private readonly serviceCalls = new BoundedMap<string, true>({ maxEntries: 1024 })
  private readonly serviceInvocations = new BoundedMap<string, Call>({ maxEntries: 1024 })
  private readonly serviceCompletions = new BoundedMap<string, z.infer<typeof daemonSchema>>({
    maxEntries: 1024
  })

  start(value: unknown, callId: string, call: Call | undefined): AgentChildWorkEvidence[] {
    const parsed = serviceSchema.safeParse(value)
    if (!parsed.success) {
      return []
    }
    const incoming = parsed.data
    if (this.serviceCalls.has(callId)) {
      return []
    }
    this.serviceCalls.set(callId, true)
    const previous = this.serviceInvocations.get(incoming.name)
    this.serviceInvocations.set(incoming.name, { nativeAt: call?.nativeAt })
    const service: Service = {
      ...call,
      ...incoming,
      callId,
      ambiguous: previous !== undefined && previous.nativeAt === call?.nativeAt
    }
    this.services.set(service.name, service)
    const live: AgentChildWorkEvidence = {
      type: 'live',
      observedAt: Date.now(),
      child: {
        handle: { idKind: 'task_id', id: `omp-service:${service.name}`, runId: callId },
        kind: 'command',
        residency: 'background',
        state: 'working',
        name: service.name,
        description: service.description,
        lastMessage: service.state,
        stoppable: false
      }
    }
    if (service.state === 'exited' || service.state === 'failed') {
      this.services.delete(service.name)
      return [
        live,
        {
          type: 'ended',
          observedAt: Date.now(),
          handle: live.child.handle,
          outcome: service.state === 'failed' ? 'failed' : 'unknown'
        }
      ]
    }
    const completion = this.serviceCompletions.get(service.name)
    return [live, ...(completion ? this.complete(completion) : [])]
  }

  complete(value: unknown): AgentChildWorkEvidence[] {
    const parsed = daemonSchema.safeParse(value)
    if (!parsed.success || !['exited', 'failed'].includes(parsed.data.state)) {
      return []
    }
    const daemon = parsed.data
    const previous = this.serviceCompletions.get(daemon.name)
    if (!previous || daemon.startedAt >= previous.startedAt) {
      this.serviceCompletions.set(daemon.name, daemon)
    }
    const service = this.services.get(daemon.name)
    if (!service) {
      return []
    }
    // Native timestamps share the remote clock; an old same-name exit cannot end a replacement.
    const tooOld = service.nativeAt !== undefined && daemon.startedAt < service.nativeAt
    const sameRun =
      !tooOld &&
      (service.pid !== undefined && daemon.pid !== undefined
        ? service.pid === daemon.pid
        : !service.ambiguous && service.nativeAt !== undefined)
    if (!sameRun) {
      return []
    }
    this.services.delete(daemon.name)
    return [
      {
        type: 'ended',
        observedAt: Date.now(),
        handle: { idKind: 'task_id', id: `omp-service:${daemon.name}`, runId: service.callId },
        outcome:
          daemon.state === 'failed' || (daemon.exitCode !== undefined && daemon.exitCode !== 0)
            ? 'failed'
            : daemon.exitCode === 0
              ? 'succeeded'
              : 'unknown'
      }
    ]
  }
}
