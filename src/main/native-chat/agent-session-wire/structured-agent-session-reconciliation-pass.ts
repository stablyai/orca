// One attempt of a chat's reconciliation worker, for a caller inside the chat's action lane: the
// short recheck and the writes. Everything owed is re-derived here from the lease, this host's
// sight of an exit and the journal, so a pass that finds nothing owed writes nothing; only what
// cannot be derived rides in from the signals (an exit's own account, a proof the lease no longer
// holds). A lease latched in recovery owes nothing until its decision releases it.
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
  /** A step could not finish: the worker retries after its backoff. */
  failed: unknown[]
  /** Rows were written, so the next pass verifies nothing is left. */
  wrote: boolean
}

/** `session`: the chat's open conversation, or the worker's own read of a closed one.
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
  const pass: StructuredAgentSessionReconciliationPass = { failed: [], wrote: false }
  if (context.deps.store.getRecord(sessionId)?.lease.handoffStage === 'recovering') {
    return pass
  }
  if (
    structuredAgentSessionEndedChildHoldsLease(context, sessionId) &&
    (await releaseLeaseOfEndedStructuredAgentSessionChild(context, sessionId))
  ) {
    pass.failed.push(new Error('agent_session_exit_release_owed'))
  }
  await settleEarlierProcess(context, sessionId, session.journal, processOpened, pass)
  const settle = (proof?: AgentSessionDeathEvidence & { ownerFence: number }) =>
    settleStructuredAgentSessionLeftovers({
      store: context.deps.store,
      sessionId,
      journal: session.journal,
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
  await attempt(() => journal.queuedMessages.repairAndPrune())
  // Before a Stop can withdraw one: a Stop never withdraws a card.
  let converted = false
  await attempt(async () => {
    converted =
      (await holdUnsentSends(journal, {
        fence,
        hostInstance: structuredAgentSessionHostInstance(),
        hold: { cause: 'hostRestarted', which: (entry) => earlier(entry.acceptedSequence) }
      })) !== null
  })
  // After every card the earlier process left, from where this process first opened the chat, so
  // a card this one queued is never held by it. Reported, never owed: the pause starts there
  // anyway, and a failed mark leaves the floor set, so the next pass marks again.
  if (converted || journal.reopenFloor() !== null) {
    const since = sameEpoch ? processOpened.sequence + 1 : undefined
    await markStructuredQueueReopen(sessionId, journal, fence, context.deps.logger, since)
  }
  // A rewind left prepared refuses every send until settled. With no provider here, one only its
  // provider can prove stays, quietly, for the next acquisition, which recovers it.
  if (!structuredRewindNeedsProvider(record.rewind)) {
    await recoverStructuredRewind(context.deps, sessionId, journal, fence).catch((error: unknown) =>
      context.deps.logger.warn('recovering a rewind an earlier process left did not finish', {
        scope: 'reconciliation-rewind',
        sessionId,
        error
      })
    )
  }
}
