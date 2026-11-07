import type { OrcaRuntimeService } from './orca-runtime'
import type { GeneratedAgentInputNotice } from '../../shared/generated-agent-input-notice'
import {
  completeNoticeOwner,
  GeneratedInputNoticeCommands,
  sameNoticeOwner,
  type CompleteNoticeOwner,
  type GeneratedInputNoticeCommand,
  type GeneratedInputNoticeOwner
} from './generated-agent-input-notice-commands'
import {
  conflictsWithNoticeIdentity,
  noticeIdentityOf,
  type GeneratedInputNoticeIdentity,
  type GeneratedInputNoticeRecord,
  type GeneratedInputNoticeRegistration
} from './generated-agent-input-notice-record'
import { GeneratedInputNoticeRecords } from './generated-agent-input-notice-records'

export type {
  GeneratedInputNoticeCommand,
  GeneratedInputNoticeOwner
} from './generated-agent-input-notice-commands'
export type { GeneratedInputNoticeRegistration } from './generated-agent-input-notice-record'
export type {
  GeneratedInputNoticeChange,
  GeneratedInputNoticeUpsert
} from './generated-agent-input-notice-records'

/** A paired host's answer to the window's request itself, as it passed back through here. */
export type GeneratedInputHostReply =
  | { kind: 'delivered' }
  | { kind: 'retained'; runtimeId: string }
  | { kind: 'failed'; certainty: GeneratedAgentInputNotice['certainty']; targetGone: boolean }

/** A host's answer to a command: it took it, it is another runtime or pairing now ('stale'), or
 *  it answered that it never can ('refused'). */
export type GeneratedInputNoticeAnswer = 'held' | 'stale' | 'refused'

/** The runtime session's notices, and for this desktop's windows the paired host each request
 *  runs on: the copy a host is owed when its answer was lost, the discard it is owed for a
 *  Dismiss made here, and the window's copy giving way once it sees the host's own. */
export class GeneratedAgentInputNotices extends GeneratedInputNoticeRecords {
  // A window's copy retired because it saw its host hold the operation; no text.
  private readonly hostHeld = new Map<string, GeneratedInputNoticeIdentity>()
  /** Owed host work; completed only by the answer to the exact command sent. */
  readonly commands = new GeneratedInputNoticeCommands()

  protected override heldElsewhere(
    id: string,
    input: GeneratedInputNoticeRegistration
  ): 'kept' | 'conflict' | null {
    const identity = this.hostHeld.get(id)
    if (!identity) {
      return null
    }
    return conflictsWithNoticeIdentity(identity, input) ? 'conflict' : 'kept'
  }

  /** A visible copy whose host may not hold one is owed to that host. */
  protected override settled(record: GeneratedInputNoticeRecord): void {
    const owner = completeNoticeOwner(record.owner)
    if (owner && !record.pending && !record.fate) {
      this.commands.owe({ kind: 'register', id: record.notice.id, owner })
    }
  }

  protected override removed(id: string): void {
    this.commands.cancelRegister(id)
  }

  protected override withheldPage(
    viewer: string,
    from: number,
    budget: number
  ): { ids: string[]; next: number | null; bytes: number } {
    return this.commands.withheldPage(viewer, from, budget)
  }

  /** The paired host's answer to the window's request. It settles the copy only; a discard the
   *  window already owes is never acknowledged by it. */
  hostAnswered(id: string, origin: string, reply: GeneratedInputHostReply): void {
    const record = this.notices.get(id)
    if (!record) {
      return
    }
    if (reply.kind === 'retained' && record.owner && !record.owner.runtimeId) {
      // The runtime that actually answered fills a receipt the window could not name.
      record.owner.runtimeId = reply.runtimeId
    }
    if (reply.kind === 'failed') {
      this.prove(id, reply.certainty, reply.targetGone)
    }
    // A host that acknowledged holding this window's copy still holds it whatever the original
    // send's late answer says, so a later Dismiss still reaches it.
    if (record.fate !== 'held') {
      record.fate = reply.kind === 'retained' ? 'held' : 'gone'
    }
    this.commands.cancelRegister(id)
    if (reply.kind !== 'failed') {
      this.settle(id, origin)
    }
  }

  /** The host answered a command; only the exact command still owed is completed by it. */
  commandAnswered(command: GeneratedInputNoticeCommand, answer: GeneratedInputNoticeAnswer): void {
    if (this.commands.complete(command) && command.kind === 'register') {
      const record = this.notices.get(command.id)
      if (record && record.owner && sameNoticeOwner(record.owner, command.owner)) {
        record.fate = answer === 'held' ? 'held' : 'gone'
      }
    }
  }

  /** The pairing this window's request goes over, fixed the first time this process resolves its
   *  environment (an ordinary status call included): every later call of it is held to that
   *  pairing, whatever the registry says by then. Undefined when the id names no request of this
   *  window, or one bound to another environment. */
  pinRoute(
    id: string,
    origin: string,
    route: { environmentId: string; pairingRevision: number }
  ): number | undefined {
    const record = this.notices.get(id)
    if (!record || record.initiator !== origin) {
      return undefined
    }
    if (record.owner && record.owner.environmentId !== route.environmentId) {
      return undefined
    }
    record.owner = {
      ...record.owner,
      environmentId: route.environmentId,
      pairingRevision: record.owner?.pairingRevision ?? route.pairingRevision
    }
    return record.owner.pairingRevision
  }

  /** The host was re-paired or removed: nothing owed to it can be delivered any more. */
  retireOwner(environmentId: string): void {
    for (const command of this.commands.owedTo(environmentId)) {
      this.commandAnswered(command, 'stale')
    }
  }

  /** The window sees the host it sent to hold this operation: its own copy, hidden or shown,
   *  gives way to the host's, never to another runtime or pairing under the same environment. */
  observeHost(id: string, viewer: string, host: CompleteNoticeOwner): void {
    const record = this.notices.get(id)
    if (
      !record ||
      record.initiator !== viewer ||
      !record.owner ||
      !sameNoticeOwner(record.owner, host)
    ) {
      return
    }
    const wasVisible = !record.pending
    this.remove(id)
    this.hostHeld.set(id, noticeIdentityOf(record))
    if (wasVisible) {
      this.publishDismissed(id, record.origin)
    }
  }

  /** Explicit discard: by a viewer of the notice (or the window holding it pending), or for an
   *  operation not recorded yet, so a late completion or registration stays discarded. A copy of a
   *  paired host's request, or `host`'s own copy as the window saw it, also owes that host the
   *  discard. False when this viewer may not discard it. */
  dismiss(id: string, viewer: string | null = null, host?: GeneratedInputNoticeOwner): boolean {
    const discarded = this.discard(id, viewer)
    if (!discarded) {
      return false
    }
    this.hostHeld.delete(id)
    const removed = discarded.record
    // Only the exact runtime the copy came from; never whatever answers under that environment now.
    const owner = removed?.owner
      ? removed.fate === 'gone'
        ? null
        : completeNoticeOwner(removed.owner)
      : completeNoticeOwner(host)
    if (owner) {
      this.commands.owe({ kind: 'discard', id, owner, origin: viewer })
    }
    return true
  }
}

export function captureGeneratedInputRecovery(
  runtime: Pick<
    OrcaRuntimeService,
    'generatedInputNotices' | 'getTerminalPtyIdForHandle' | 'getTerminalWorktreeIdForHandle'
  >,
  handle: string,
  agent: GeneratedAgentInputNotice['agent'],
  text: string,
  submitted = true
): (certainty: GeneratedAgentInputNotice['certainty']) => void {
  return runtime.generatedInputNotices.recovery({
    handle,
    agent,
    text,
    ...(submitted ? {} : { submitted: false }),
    ptyId: runtime.getTerminalPtyIdForHandle(handle),
    worktreeId: runtime.getTerminalWorktreeIdForHandle(handle) ?? ''
  })
}
