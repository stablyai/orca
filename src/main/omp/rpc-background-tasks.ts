import { z } from 'zod'
import { BoundedMap } from '../../shared/bounded-map'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'
import { ompNativeToolResults } from './rpc-tool-results'
import { OmpRpcBackgroundServices } from './rpc-background-services'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'

const id = z.string().min(1).max(512)
const preview = z.string().transform((text) => text.slice(0, 512))
const jobStatus = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled'])
const jobSchema = z.object({
  id,
  type: z.enum(['bash', 'task', 'eval']),
  status: jobStatus,
  label: preview.optional(),
  widget: z.object({ title: preview.optional(), stage: preview.optional() }).optional()
})
const asyncSchema = z.object({ jobId: id, type: jobSchema.shape.type, state: jobStatus })
const callSchema = z.object({
  toolCallId: id,
  toolName: z.string(),
  args: z.object({ command: preview.optional(), code: preview.optional() }).optional()
})
const detailsSchema = z.object({ details: z.record(z.string(), z.unknown()) })
const messageSchema = z.object({
  role: z.string(),
  customType: z.string().optional(),
  timestamp: z.number().finite().optional(),
  details: z.record(z.string(), z.unknown()).optional()
})

type Call = { description?: string; nativeAt?: number }
type Job = z.infer<typeof jobSchema>

export class OmpRpcBackgroundTasks {
  // Background Eval can return nested results after its initial tool end.
  private readonly calls = new BoundedMap<string, Call>({ maxEntries: 1024 })
  private readonly jobs = new Map<string, Job>()
  private readonly completed = new BoundedMap<string, true>({ maxEntries: 1024 })
  private readonly services = new OmpRpcBackgroundServices()
  private nativeAt?: number

  receive(frame: JsonlRpcRecord): AgentChildWorkEvidence[] {
    if (frame.type === 'tool_execution_start') {
      const call = callSchema.safeParse(frame)
      if (call.success) {
        this.calls.set(call.data.toolCallId, {
          description: call.data.args?.command ?? call.data.args?.code,
          nativeAt: this.nativeAt
        })
      }
      return []
    }
    if (frame.type === 'message_start' || frame.type === 'message_end') {
      const message = messageSchema.safeParse(frame.message)
      if (!message.success) {
        return []
      }
      if (message.data.role === 'assistant') {
        this.nativeAt = message.data.timestamp
      }
      if (message.data.role !== 'custom') {
        return []
      }
      const details = message.data.details
      if (message.data.customType === 'async-result' && Array.isArray(details?.jobs)) {
        return details.jobs.flatMap((value) => {
          const parsed = z.object({ jobId: id, status: jobStatus.optional() }).safeParse(value)
          return parsed.success
            ? this.endJob(parsed.data.jobId, parsed.data.status ?? 'unknown')
            : []
        })
      }
      if (message.data.customType === 'launch-completion' && Array.isArray(details?.daemons)) {
        return details.daemons.flatMap((value) => this.services.complete(value))
      }
      return []
    }
    if (frame.type !== 'tool_execution_end' && frame.type !== 'tool_execution_update') {
      return []
    }
    const ended = frame.type === 'tool_execution_end'
    const callId = typeof frame.toolCallId === 'string' ? frame.toolCallId : ''
    const call = this.calls.get(callId)
    const result = detailsSchema.safeParse(ended ? frame.result : frame.partialResult)
    if (!result.success) {
      return []
    }
    const evidence: AgentChildWorkEvidence[] = []
    for (const { details, path, returned, toolName } of ompNativeToolResults(
      result.data.details,
      typeof frame.toolName === 'string' ? frame.toolName : undefined
    )) {
      const async = asyncSchema.safeParse(details.async)
      if (async.success) {
        const { jobId, type, state } = async.data
        if (
          ended ||
          returned ||
          this.jobs.has(jobId) ||
          (state !== 'running' && state !== 'pending')
        ) {
          evidence.push(
            ...this.job({
              id: jobId,
              type,
              status: state,
              label: path ? undefined : call?.description
            })
          )
        }
      }
      const proc = isRecord(details.proc) ? details.proc : undefined
      // Neither wait nor proc snapshots make absent jobs terminal.
      const snapshot =
        proc ??
        (toolName === 'wait' || details.op === 'wait' || details.op === 'cancel'
          ? details
          : undefined)
      if (snapshot) {
        const jobs = Array.isArray(snapshot.jobs)
          ? snapshot.jobs
          : snapshot.job
            ? [snapshot.job]
            : []
        for (const value of jobs) {
          const parsed = jobSchema.safeParse(value)
          if (parsed.success) {
            evidence.push(...this.job(parsed.data))
          }
        }
        const daemons = Array.isArray(snapshot.daemons)
          ? snapshot.daemons
          : snapshot.daemon
            ? [snapshot.daemon]
            : []
        for (const daemon of daemons) {
          evidence.push(...this.services.complete(daemon))
        }
      }
      if ((ended && toolName === 'bash') || returned) {
        evidence.push(
          ...this.services.start(details.service, path ? `${callId}:${path}` : callId, call)
        )
      }
    }
    return evidence
  }

  private job(incoming: Job): AgentChildWorkEvidence[] {
    if (incoming.type === 'task' || this.completed.has(incoming.id)) {
      return []
    }
    const terminal = this.endJob(incoming.id, incoming.status)
    if (incoming.status !== 'running' && incoming.status !== 'pending') {
      return terminal
    }
    const previous = this.jobs.get(incoming.id)
    const job = {
      ...previous,
      ...incoming,
      label: incoming.label ?? previous?.label,
      widget: incoming.widget ?? previous?.widget
    }
    this.jobs.set(job.id, job)
    return [
      {
        type: 'live',
        observedAt: Date.now(),
        child: {
          handle: { idKind: 'task_id', id: `omp-job:${job.id}` },
          kind: job.type === 'eval' ? 'workflow' : 'command',
          residency: 'background',
          state: job.status === 'pending' ? 'waiting' : 'working',
          name: job.widget?.title ?? job.label ?? job.id,
          description: job.label,
          lastMessage: job.widget?.stage,
          stoppable: false
        }
      }
    ]
  }

  private endJob(
    jobId: string,
    status: z.infer<typeof jobStatus> | 'unknown'
  ): AgentChildWorkEvidence[] {
    if (status === 'running' || status === 'pending' || this.completed.has(jobId)) {
      return []
    }
    this.completed.set(jobId, true)
    if (!this.jobs.delete(jobId)) {
      return []
    }
    return [
      {
        type: 'ended',
        observedAt: Date.now(),
        handle: { idKind: 'task_id', id: `omp-job:${jobId}` },
        outcome:
          status === 'completed'
            ? 'succeeded'
            : status === 'cancelled'
              ? 'cancelled'
              : status === 'failed'
                ? 'failed'
                : 'unknown'
      }
    ]
  }
}
