import type { DaemonClient } from '../../transport/client/daemon-client'
import type { HistoryManager } from '../../history/storage/history-manager'
import type { HistoryWriterAdmission } from '../../history/storage/terminal-history-writer-handoff'
import {
  TerminalHistoryUnavailableError,
  type FlushHistoryResult,
  type TerminalHistoryOutcome
} from '../../protocol/daemon-history-protocol'
import type { GetSnapshotResult } from '../../protocol/daemon-rpc-contract'
import type { TerminalHistoryAuthority } from '../../../providers/pty-provider-contract'
import { normalizeDesktopTerminalSnapshotRows } from '../../../../shared/terminal/replay/terminal-scrollback-policy'
import {
  awaitDaemonWorkWithinCallerDeadline,
  remainingDaemonRequestTimeoutMs
} from '../../launch/daemon-request-deadline'
import type { HistoryRecoveryContext } from './daemon-pty-runtime-state'

// Legacy predecessors' already-issued file work; a stalled disk fails this start, never its fence.
const HOST_HISTORY_HANDOFF_WAIT_MS = 10_000

export type ShutdownOptions = {
  immediate?: boolean
  keepHistory?: boolean
  deadlineMs?: number
  /** A close's removal claim, captured before its lock and kill awaits. */
  historyAdmission?: HistoryWriterAdmission
}

type HostHistoryBinding = {
  incarnationId: string | undefined
  /** Absent for a binding adopted live from the daemon: no main writer ever needed fencing. */
  admission: HistoryWriterAdmission | undefined
  outcome: TerminalHistoryOutcome | undefined
}

/**
 * Host-owned history authority per live PTY binding. It survives disconnect and inventory
 * resets, and ends only when that exact binding is replaced, exits or its adapter retires.
 */
export class DaemonPtyHostHistoryBindings {
  private readonly bindings = new Map<string, HostHistoryBinding>()

  constructor(
    readonly enabled: boolean,
    private readonly isLive: (sessionId: string) => boolean,
    // A late exit must not close a claim a same-ID successor's start already holds.
    private readonly claims: () => Pick<HistoryManager, 'releaseUnheld'> | null
  ) {}

  bind(sessionId: string, binding: HostHistoryBinding): void {
    const previous = this.bindings.get(sessionId)
    if (previous?.admission && previous.admission !== binding.admission) {
      previous.admission.release()
    }
    this.bindings.set(sessionId, binding)
  }

  /** A create/attach result's binding; a remapped claim never mints a fence for its new ID. */
  bindResult(
    sessionId: string,
    result: { incarnationId?: string; history?: TerminalHistoryOutcome },
    historyRecovery: HistoryRecoveryContext
  ): void {
    if (this.enabled) {
      this.bind(sessionId, {
        incarnationId: result.incarnationId,
        admission: historyRecovery.identityChanged
          ? this.bindings.get(sessionId)?.admission
          : historyRecovery.admission,
        outcome: result.history
      })
    }
  }

  get(sessionId: string): HostHistoryBinding | undefined {
    return this.bindings.get(sessionId)
  }

  release(sessionId: string, incarnationId?: string): void {
    const binding = this.bindings.get(sessionId)
    if (binding && (incarnationId === undefined || binding.incarnationId === incarnationId)) {
      this.bindings.delete(sessionId)
      if (binding.admission) {
        // Every binding claim comes from this store's holds.
        this.claims()?.releaseUnheld(sessionId, binding.admission)
      }
    }
  }

  clear(): void {
    this.bindings.clear()
  }

  /** A host claim outlives its spawn only as a live binding's fence. */
  releaseUnbound(sessionId: string, admission: HistoryWriterAdmission | undefined): void {
    if (this.enabled && !this.bindings.has(sessionId)) {
      admission?.release()
    }
  }

  /**
   * Before a create: predecessors are closed and their issued work settles. A legacy install
   * still unsettled after the wait leaves history suspended; a host create refuses instead.
   */
  async handOff(
    store: HistoryManager | null,
    historyRecovery: HistoryRecoveryContext,
    sessionId: string,
    attachOnly: boolean
  ): Promise<void> {
    const admission = historyRecovery.admission
    if (!admission) {
      return
    }
    const ready = await awaitHistoryAdmissionReady(admission)
    if (!this.enabled) {
      return
    }
    if (!ready) {
      throw new TerminalHistoryUnavailableError()
    }
    const freeze = historyRecovery.freeze
    if (!attachOnly && freeze && historyRecovery.unreadableSessionId === sessionId) {
      // Unreadable recovery moves aside intact; the daemon's new origin cannot overwrite it.
      historyRecovery.freeze = null
      historyRecovery.unreadableSessionId = null
      store?.quarantineRecovery(sessionId, freeze, admission)
    }
    if (!admission.current()) {
      throw new TerminalHistoryUnavailableError()
    }
  }

  /**
   * Sleep of the binding captured before the folder probe: the daemon proves recoverable history,
   * ends that exact process and verifies its final cut. The incarnation, only for its receipt.
   */
  async finalizeSleep(
    client: DaemonClient,
    sessionId: string,
    binding: HostHistoryBinding | undefined,
    opts: { cwd: string | null; immediate?: boolean; deadlineMs?: number }
  ): Promise<string | null> {
    const incarnationId = binding?.incarnationId
    if (!incarnationId || this.bindings.get(sessionId) !== binding) {
      return null
    }
    try {
      const result = await client.request<FlushHistoryResult>(
        'flushHistory',
        {
          sessionId,
          intent: 'sleep',
          expectedIncarnationId: incarnationId,
          ...(opts.cwd ? { cwdObservation: { cwd: opts.cwd } } : {}),
          immediate: opts.immediate === true
        },
        remainingDaemonRequestTimeoutMs(opts.deadlineMs)
      )
      return result.status === 'finalized' && isHostHistoryReceipt(result, incarnationId)
        ? incarnationId
        : null
    } catch {
      return null
    }
  }

  /** Undefined means a legacy or unknown route; an adopted live host session has no other owner. */
  authority(sessionId: string): TerminalHistoryAuthority | undefined {
    const binding = this.bindings.get(sessionId)
    return binding || (this.enabled && this.isLive(sessionId))
      ? { owner: 'host', incarnationId: binding?.incarnationId }
      : undefined
  }
}

export function newHistoryRecoveryContext(
  admission: HistoryWriterAdmission | undefined
): HistoryRecoveryContext {
  return { admission, freeze: null, unreadableSessionId: null, identityChanged: false }
}

export function awaitHistoryAdmissionReady(admission: HistoryWriterAdmission): Promise<boolean> {
  return awaitDaemonWorkWithinCallerDeadline(
    admission.ready,
    Date.now() + HOST_HISTORY_HANDOFF_WAIT_MS
  )
}

/** Quit's durable cut for one captured binding; the terminal keeps running either way. */
export async function commitHostHistory(
  client: DaemonClient,
  sessionId: string,
  incarnationId: string,
  opts: { cwd: string | undefined; deadlineMs: number }
): Promise<boolean> {
  try {
    const result = await client.request<FlushHistoryResult>(
      'flushHistory',
      {
        sessionId,
        intent: 'commit',
        expectedIncarnationId: incarnationId,
        ...(opts.cwd ? { cwdObservation: { cwd: opts.cwd } } : {})
      },
      remainingDaemonRequestTimeoutMs(opts.deadlineMs)
    )
    return result.status === 'committed' && isHostHistoryReceipt(result, incarnationId)
  } catch {
    return false
  }
}

function isHostHistoryReceipt(
  result: Exclude<FlushHistoryResult, { status: 'unavailable' }>,
  incarnationId: string
): boolean {
  const counts = [result.appliedRevision, result.outputSequence, result.generation, result.logBytes]
  return (
    result.incarnationId === incarnationId &&
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    ['none', 'published', 'folded', 'rejected'].includes(result.cwdNote) &&
    (result.status !== 'finalized' || result.backing === 'checkpoint' || result.backing === 'raw')
  )
}

/** The daemon's image for this binding; null is unavailable, never a cue to read another model. */
export async function readHostHistorySnapshot(
  client: DaemonClient,
  sessionId: string,
  incarnationId: string | undefined,
  requestedRows: number | undefined
): Promise<NonNullable<GetSnapshotResult['snapshot']> | null> {
  try {
    const scrollbackRows = normalizeDesktopTerminalSnapshotRows(requestedRows)
    const result = await client.request<GetSnapshotResult>('getSnapshot', {
      sessionId,
      ...(scrollbackRows !== undefined ? { scrollbackRows } : {}),
      ...(incarnationId ? { expectedIncarnationId: incarnationId } : {})
    })
    const history = result.history
    // Past a gap only the live window is proven; a deeper read cannot claim to cross it.
    return result.snapshot &&
      (history?.kind === 'origin' ||
        history?.kind === 'fold' ||
        (history?.kind === 'gap' && scrollbackRows === 0))
      ? result.snapshot
      : null
  } catch {
    return null
  }
}
