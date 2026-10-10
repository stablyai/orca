// One visit of the host's retry to a chat, for a caller inside the chat's action lane: the short
// recheck and the writes, all through the background handles (`structured-agent-session-
// background-writes.ts`), so another connection's lock ends the round instead of waiting. Everything owed is re-derived here from the lease, this host's
// sight of an exit and the journal, so a pass that finds nothing owed writes nothing; only what
// cannot be derived rides in from the signals (an exit's own account, a proof the lease no longer
// holds). A lease latched in recovery still gets (b), which touches no process and no lease, as
// every open did on main; (a) and (c) wait for its decision, whose release signals again.
//
// The steps stay apart, so one never retires another's debt:
//  (a) lease-release repair: an exit this host observed whose release write failed;
//  (b) what an earlier host process left: the cards' repair and prune, and the unsent sends it
//      accepted kept as cards; then, best effort, the queue's reopen mark and a rewind left in
//      doubt (neither is owed: the pause is derived from where the handle opened, and a rewind
//      only its provider can prove waits for an acquisition);
//  (c) item settlement (`settleStructuredAgentSessionLeftovers`), one planned batch.
// An empty item plan says nothing of (a) or (b).

import { holdUnsentSends } from '../agent-session-journal/journal-unsent-send-hold'
import {
  backgroundJournalWrites,
  backgroundStoreWrites,
  type BackgroundJournalWrites,
  type BackgroundStoreWrites
} from './structured-agent-session-background-writes'
import { isSqliteContentionFailure } from '../../sqlite/sqlite-read-failure'
import { queuedMessageReopenMarkStart } from '../agent-session-journal/queued-message-reopen-floor'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  releaseLeaseOfEndedStructuredAgentSessionChild,
  structuredAgentSessionEndedChildHoldsLease
} from './structured-agent-session-child-close'
import {
  settleStructuredAgentSessionLeftovers,
  type StructuredAgentSessionExitSettlement
} from './structured-agent-session-leftover-settlement'
import {
  markStructuredQueueReopen,
  structuredAgentSessionHostInstance
} from './structured-agent-session-queued-pause'
import {
  recoverStructuredRewind,
  structuredRewindNeedsProvider
} from './structured-rewind-recovery'

export type StructuredAgentSessionReconciliationPassContext = Pick<
  StructuredAgentSessionLifetimeContext,
  'deps' | 'sessions' | 'now'
>

/** What the signals left that the journal and the lease cannot tell. */
export type StructuredAgentSessionReconciliationDebts = {
  exit?: StructuredAgentSessionExitSettlement
  /** Each ended generation's proof, as its end carried it: a reservation clears the lease's, and a
   *  later release replaces it with its own. */
  evidence?: AgentSessionDeathEvidence[]
}

export type StructuredAgentSessionReconciliationPass = {
  /** A step could not finish: the retry visits again after its backoff. */
  failed: unknown[]
  /** Rows were written, so the next pass verifies nothing is left. */
  wrote: boolean
  /** The lease is latched in recovery: what ended waits for its decision's signal. */
  recovering: boolean
}

/** `session`: the chat's open conversation, or the retry's own read of a closed one.
 *  `processOpened`: where this host first opened the chat's journal; a send at or before it was an
 *  earlier process's. A later handle's own open cannot tell: this process may have accepted sends
 *  through an earlier handle, which its close or its delivery loop still owns. */
export async function runStructuredAgentSessionReconciliationPass(
  context: StructuredAgentSessionReconciliationPassContext,
  sessionId: string,
  session: Pick<StructuredAgentSessionHostSession, 'journal' | 'lastEndedChild'>,
  debts: StructuredAgentSessionReconciliationDebts,
  processOpened: AgentJournalCursor
): Promise<StructuredAgentSessionReconciliationPass> {
  const lease = context.deps.store.getRecord(sessionId)?.lease
  const recovering = lease?.handoffStage === 'recovering'
  const pass: StructuredAgentSessionReconciliationPass = { failed: [], wrote: false, recovering }
  // Every write a pass makes is bookkeeping no person waits on: only these handles write.
  const writes = {
    store: backgroundStoreWrites(context.deps.store),
    journal: backgroundJournalWrites(session.journal)
  }
  // An exit's account judges only its own generation: once a later one acquired, it is spent.
  if (debts.exit && (!lease || lease.runtimeFence > debts.exit.ownerFence + 1)) {
    delete debts.exit
  }
  if (
    !recovering &&
    structuredAgentSessionEndedChildHoldsLease(context, sessionId) &&
    (await releaseLeaseOfEndedStructuredAgentSessionChild(context, sessionId, writes.store))
  ) {
    pass.failed.push(new Error('agent_session_exit_release_owed'))
  }
  await settleEarlierProcess(context, sessionId, session.journal, writes, processOpened, pass)
  if (recovering || pass.failed.some(isSqliteContentionFailure)) {
    // What ended is not known until its recovery is decided; the debts wait for that signal.
    return pass
  }
  const settle = (proof?: AgentSessionDeathEvidence & { ownerFence: number }) =>
    settleStructuredAgentSessionLeftovers({
      store: context.deps.store,
      sessionId,
      journal: session.journal,
      writes: writes.journal,
      ...(debts.exit ? { exit: debts.exit } : {}),
      ...(session.lastEndedChild ? { ended: session.lastEndedChild } : {}),
      ...(proof ? { proof } : {})
    })
  // Each proof the lease no longer holds judges what its own generation left, oldest first.
  const leaseEvidence = context.deps.store.getRecord(sessionId)?.lease.deathEvidence ?? null
  for (const proof of heldProofs(debts, leaseEvidence)) {
    const settled = await settle(proof)
    if (!settled.ok) {
      pass.failed.push(settled.error)
      return pass
    }
    pass.wrote ||= settled.planned > 0
  }
  const settled = await settle()
  if (!settled.ok) {
    pass.failed.push(settled.error)
    return pass
  }
  // Kept until everything they judge is settled: a later reservation clears the lease's copy.
  delete debts.evidence
  // Written, or overtaken by a later generation: either way the exit's account is spent.
  delete debts.exit
  pass.wrote ||= settled.planned > 0
  return pass
}

function heldProofs(
  debts: StructuredAgentSessionReconciliationDebts,
  leaseEvidence: AgentSessionDeathEvidence | null
): (AgentSessionDeathEvidence & { ownerFence: number })[] {
  return (debts.evidence ?? [])
    .filter(
      (evidence): evidence is AgentSessionDeathEvidence & { ownerFence: number } =>
        evidence.ownerFence !== undefined &&
        !(
          leaseEvidence?.ownerFence === evidence.ownerFence &&
          leaseEvidence.observedAt === evidence.observedAt
        )
    )
    .sort((left, right) => left.ownerFence - right.ownerFence)
}

/** Each step finds its own debt in memory and writes only what it finds, so it is safe on every
 *  pass: the conversion, sends still queued from an earlier process; the mark, a converted send or
 *  a reopen floor this handle has not marked; the rewind, a record still in doubt. */
async function settleEarlierProcess(
  context: StructuredAgentSessionReconciliationPassContext,
  sessionId: string,
  journal: StructuredAgentSessionHostSession['journal'],
  writes: { store: BackgroundStoreWrites; journal: BackgroundJournalWrites },
  processOpened: AgentJournalCursor,
  pass: StructuredAgentSessionReconciliationPass
): Promise<void> {
  const record = context.deps.store.getRecord(sessionId)
  if (!record) {
    return
  }
  const fence = record.lease.runtimeFence
  const sameEpoch = processOpened.epoch === journal.cursor().epoch
  const earlier = (sequence: number | undefined): boolean =>
    sameEpoch && sequence !== undefined && sequence <= processOpened.sequence
  const attempt = async (step: () => Promise<unknown>): Promise<boolean> =>
    step().then(
      () => true,
      (error: unknown) => {
        pass.failed.push(error)
        return false
      }
    )
  // Another connection's lock ends the pass: the round ends, and every step is tried again.
  if (!(await attempt(() => writes.journal.queuedMessages.repairAndPrune()))) {
    return
  }
  // Before a Stop can withdraw one: a Stop never withdraws a card.
  let converted = false
  const held = await attempt(async () => {
    converted =
      (await holdUnsentSends(journal, {
        fence,
        hostInstance: structuredAgentSessionHostInstance(),
        hold: { cause: 'hostRestarted', which: (entry) => earlier(entry.acceptedSequence) },
        writes: writes.journal
      })) !== null
  })
  if (!held && pass.failed.some(isSqliteContentionFailure)) {
    return
  }
  // After every card the earlier process left, so a card this one queued is never held by it.
  // Reported, never owed: the pause starts there anyway, and a failed mark leaves the floor set,
  // so the next pass marks again.
  const floor = journal.reopenFloor()
  const since = queuedMessageReopenMarkStart(floor, processOpened, journal.cursor().epoch)
  if ((converted || floor !== null) && since !== null) {
    await markStructuredQueueReopen(sessionId, writes.journal, fence, context.deps.logger, since)
  }
  // A rewind left prepared refuses every send until settled. With no provider here, one only its
  // provider can prove stays, quietly, for the next acquisition, which recovers it.
  if (!structuredRewindNeedsProvider(record.rewind)) {
    const deps = { ...context.deps, background: writes }
    await recoverStructuredRewind(deps, sessionId, journal, fence).catch((error: unknown) => {
      // Another connection's lock ends the round, as every other write here does.
      if (isSqliteContentionFailure(error)) {
        pass.failed.push(error)
        return
      }
      context.deps.logger.warn('recovering a rewind an earlier process left did not finish', {
        scope: 'reconciliation-rewind',
        sessionId,
        error
      })
    })
  }
}
