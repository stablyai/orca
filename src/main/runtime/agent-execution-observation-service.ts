import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import {
  AgentExecutionObservationScheduler,
  type AgentExecutionAttachment,
  type AgentExecutionHostInventory,
  type AgentExecutionObservation,
  type AgentExecutionObservationSchedulerOptions
} from '../../shared/agent-execution-observation'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { withTimeoutResult } from './runtime-async-boundaries'
import { inspectProcessVerdicts, processIncarnations } from './agent-execution-observation-process'

type Dependencies = {
  /** The controller is selected by execution host; no local fallback is allowed for SSH. */
  getController(hostId: ExecutionHostId): RuntimePtyController | null
  /** Host-local epoch changes when a daemon/relay restarts and invalidates old captures. */
  getHostEpoch(hostId: ExecutionHostId): string
  /** Reads the committed owner registry; this is the sole attachment source. */
  getAttachments(): readonly AgentExecutionAttachment[]
  publish(observation: AgentExecutionObservation, attachment?: AgentExecutionAttachment): void
  listDeadlineMs?: number
}

/**
 * Runtime composition for the shared observation scheduler.
 *
 * The provider inventory is authoritative only for the host it answers for.
 * A missing controller, timeout, relay failure, or incomplete host scope is
 * deliberately surfaced as `unverifiable`; no local process list can answer
 * for an SSH attachment.
 */
export class AgentExecutionObservationService {
  private readonly scheduler: AgentExecutionObservationScheduler
  private readonly deadlineMs: number
  /**
   * Provider calls cannot all be cancelled (notably older SSH relays). Keep a
   * timed-out host operation fenced until it settles so a retry never overlaps
   * the still-running RPC and multiplies host work.
   */
  private readonly inFlightHostOperations = new Map<ExecutionHostId, Promise<void>>()
  private pollingHandle: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(
    private readonly deps: Dependencies,
    options: AgentExecutionObservationSchedulerOptions = {}
  ) {
    this.deadlineMs = Math.max(1, deps.listDeadlineMs ?? 2_000)
    this.scheduler = new AgentExecutionObservationScheduler(
      (hostId, signal, attachments) => this.scanHost(hostId, signal, attachments),
      (observation) => {
        const attachment = deps
          .getAttachments()
          .find((candidate) => candidate.executionId === observation.executionId)
        if (
          !attachment ||
          attachment.hostId !== observation.hostId ||
          attachment.hostEpoch !== observation.hostEpoch
        ) {
          return
        }
        deps.publish(observation, attachment)
      },
      options
    )
  }

  /** Reconciles the registry before each poll; stale reservations cannot linger. */
  syncAttachments(): void {
    const current = new Map(
      this.deps.getAttachments().map((attachment) => [attachment.executionId, attachment])
    )
    const known = new Set<string>()
    for (const attachment of current.values()) {
      known.add(attachment.executionId)
      this.scheduler.register(attachment)
    }
    for (const executionId of this.scheduler.getRegisteredExecutionIds()) {
      if (!known.has(executionId)) {
        this.scheduler.unregister(executionId)
      }
    }
  }

  observe(executionId: string): Promise<AgentExecutionObservation> {
    this.syncAttachments()
    return this.scheduler.request(executionId)
  }

  observeAll(): Promise<AgentExecutionObservation[]> {
    this.syncAttachments()
    return Promise.all(
      this.deps.getAttachments().map((attachment) => this.scheduler.request(attachment.executionId))
    )
  }

  getPublished(executionId: string): AgentExecutionObservation | undefined {
    return this.scheduler.getPublished(executionId)
  }

  /** Starts one bounded host sweep cadence shared by every committed attachment. */
  start(intervalMs = 5_000): void {
    if (this.pollingHandle !== null) {
      return
    }
    this.stopped = false
    const poll = (): void => {
      this.pollingHandle = null
      if (this.stopped) {
        return
      }
      void this.observeAll().catch((error) => {
        console.warn('[agent-execution-observation] sweep failed', error)
      })
      this.pollingHandle = setTimeout(poll, Math.max(100, intervalMs))
      this.pollingHandle.unref?.()
    }
    poll()
  }

  stop(): void {
    this.stopped = true
    if (this.pollingHandle !== null) {
      clearTimeout(this.pollingHandle)
      this.pollingHandle = null
    }
    this.scheduler.stop()
  }

  private async scanHost(
    hostId: ExecutionHostId,
    signal: AbortSignal,
    attachments: readonly AgentExecutionAttachment[]
  ): Promise<AgentExecutionHostInventory> {
    const controller = this.deps.getController(hostId)
    if (!controller || signal.aborted) {
      throw new Error('execution_observation_controller_unavailable')
    }
    if (this.inFlightHostOperations.has(hostId)) {
      throw new Error('execution_observation_host_scan_in_flight')
    }
    const parsed = parseExecutionHostId(hostId)
    const deadlineMs = Date.now() + this.deadlineMs
    const operation = this.readHostInventory(
      hostId,
      parsed,
      controller,
      signal,
      attachments,
      deadlineMs
    )
    const settled = operation.then(
      () => undefined,
      () => undefined
    )
    this.inFlightHostOperations.set(hostId, settled)
    void settled.then(() => {
      if (this.inFlightHostOperations.get(hostId) === settled) {
        this.inFlightHostOperations.delete(hostId)
      }
    })
    const result = await withTimeoutResult(operation, this.deadlineMs)
    if (!result.ok) {
      throw new Error('execution_observation_timeout')
    }
    return result.value
  }

  private async readHostInventory(
    hostId: ExecutionHostId,
    parsed: ReturnType<typeof parseExecutionHostId>,
    controller: RuntimePtyController,
    signal: AbortSignal,
    attachments: readonly AgentExecutionAttachment[],
    deadlineMs: number
  ): Promise<AgentExecutionHostInventory> {
    if (parsed?.kind === 'local' && controller.listProcessesWithHostScope) {
      const result = await controller.listProcessesWithHostScope({
        deadlineMs,
        includeForegroundProcessEvidence: true
      })
      if (signal.aborted) {
        throw new Error('execution_observation_aborted')
      }
      const hostIds = new Set(result.hostIds)
      return {
        hostId,
        hostEpoch: this.deps.getHostEpoch(hostId),
        capturedAt: Date.now(),
        inventoryCoverage: hostIds.has(hostId) ? 'complete' : 'partial',
        processIncarnations: processIncarnations(result.processes),
        verdictByProcessIncarnation: await inspectProcessVerdicts(
          controller,
          attachments,
          result.processes,
          deadlineMs,
          signal
        )
      }
    }
    if (parsed?.kind === 'ssh' && controller.listProcesses) {
      const processes = await controller.listProcesses(parsed.targetId, {
        deadlineMs,
        includeForegroundProcessEvidence: true
      })
      if (signal.aborted) {
        throw new Error('execution_observation_aborted')
      }
      return {
        hostId,
        hostEpoch: this.deps.getHostEpoch(hostId),
        capturedAt: Date.now(),
        inventoryCoverage: 'complete',
        processIncarnations: processIncarnations(processes),
        verdictByProcessIncarnation: await inspectProcessVerdicts(
          controller,
          attachments,
          processes,
          deadlineMs,
          signal
        )
      }
    }
    throw new Error('execution_observation_inventory_unavailable')
  }
}

export function hostIdForConnection(connectionId: string): ExecutionHostId {
  return toSshExecutionHostId(connectionId)
}
