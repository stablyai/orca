import {
  USAGE_LIMIT_CONTINUE_CHAIN_LIMIT,
  switchFreeIdentity,
  type HostUsageLimitCut,
  type SwitchReset
} from './structured-agent-session-usage-limit-chain'
import type { UsageLimitContinueDeps } from './structured-agent-session-usage-limit-continue-deps'

/** Whether the connector requests a usage-limit cut owes still wait for its automatic continue
 *  (Phase 1 §1.5). */
export type UsageLimitCutDisposition = 'pending' | 'ended' | 'ambiguous'

export async function readUsageLimitCutDisposition(input: {
  host: UsageLimitContinueDeps['host']
  sessionId: string
  turnItemId: string
  readCut: () => Promise<HostUsageLimitCut | null>
  isEnabled: () => boolean
  schedulable: (cut: HostUsageLimitCut) => boolean
  attempt: () => { identity: string; count: number; unconfirmed?: boolean } | undefined
}): Promise<UsageLimitCutDisposition> {
  const { host, sessionId, turnItemId } = input
  const backup = host.usageLimitAutoContinue?.botBackupFailover
  if (backup?.isSwitching(sessionId, turnItemId)) {
    return 'pending'
  }
  if (backup?.isSuperseded(sessionId, turnItemId)) {
    return 'ended'
  }
  const cut = await input.readCut()
  if (backup?.isSwitching(sessionId, turnItemId)) {
    return 'pending'
  }
  if (backup?.isSuperseded(sessionId, turnItemId)) {
    return 'ended'
  }
  const record = host.store.getRecord(sessionId)
  const attempt = input.attempt()
  return usageLimitCutDisposition({
    cut,
    turnItemId,
    continuable:
      cut !== null &&
      input.isEnabled() &&
      input.schedulable(cut) &&
      record?.location.executionHostId === host.store.hostId &&
      isUsageLimitChatOpen(host.store, sessionId),
    cancel: record?.usageLimitContinueCancel,
    attempt: cut && attempt?.identity === switchFreeIdentity(cut) ? attempt : undefined
  })
}

type OpenChats = {
  listVisibleSessionIds(): string[]
  listBackgroundSessionIds(): string[]
  isSessionTabVisible(id: string): boolean
  isSessionInBackground(id: string): boolean
}

/** Chats still open: those with a tab, and tabless ones nobody closed (bot and worker chats). */
export const openUsageLimitChats = (store: OpenChats): string[] => [
  ...new Set([...store.listVisibleSessionIds(), ...store.listBackgroundSessionIds()])
]

export const isUsageLimitChatOpen = (store: OpenChats, id: string): boolean =>
  store.isSessionTabVisible(id) || store.isSessionInBackground(id)

/** Everything but a reset to wait for: Orca would continue this cut once it has one. */
export function usageLimitCutContinuable(
  host: Pick<UsageLimitContinueDeps['host'], 'store' | 'usageLimitAutoContinue'>,
  id: string,
  cut: HostUsageLimitCut
): boolean {
  const record = host.store.getRecord(id)
  return (
    cut.chain < USAGE_LIMIT_CONTINUE_CHAIN_LIMIT &&
    host.usageLimitAutoContinue?.isEnabled() === true &&
    record !== null &&
    record.location.executionHostId === host.store.hostId &&
    !host.usageLimitAutoContinue?.isWorkspaceAsleep(record.location.workspaceId) &&
    isUsageLimitChatOpen(host.store, id) &&
    !cancelsCut(record.usageLimitContinueCancel, cut)
  )
}

type Cancel = { turnItemId: string; resetsAt: number } | undefined

/** A person's cancel of this very cut. A switch's or room's time is not kept, so a cut whose
 *  reset they stand in for, or would once seen, matches by turn. */
export const cancelsCut = (
  cancel: Cancel,
  cut: Pick<HostUsageLimitCut, 'turnItemId' | 'resetsAt'> & SwitchReset
) =>
  cancel?.turnItemId === cut.turnItemId &&
  (cut.resetFromSwitch === true || cut.resetsAt === undefined || cancel.resetsAt === cut.resetsAt)

/** Pending through a temporary hold (asleep workspace, moving attribution, an unread reset);
 *  ambiguous after a send that threw unconfirmed; ended once no continue will come for this cut:
 *  cancelled, chain or attempt budget spent, setting off, passed to another host, or chat closed. */
export function usageLimitCutDisposition(facts: {
  cut: HostUsageLimitCut | null
  turnItemId: string
  /** Every standing condition a continue needs: setting on, this host's, chat open, schedulable. */
  continuable: boolean
  cancel: Cancel
  attempt: { count: number; unconfirmed?: boolean } | undefined
}): UsageLimitCutDisposition {
  const { cut, attempt } = facts
  if (
    !cut ||
    cut.turnItemId !== facts.turnItemId ||
    !facts.continuable ||
    cut.chain >= USAGE_LIMIT_CONTINUE_CHAIN_LIMIT ||
    cancelsCut(facts.cancel, cut) ||
    (attempt?.count ?? 0) >= 5
  ) {
    return 'ended'
  }
  return attempt?.unconfirmed ? 'ambiguous' : 'pending'
}
