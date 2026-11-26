import type { HostUsageLimitCut, SwitchReset } from './structured-agent-session-usage-limit-chain'
import { USAGE_LIMIT_CONTINUE_CHAIN_LIMIT } from './structured-agent-session-usage-limit-chain'
import type { UsageLimitContinueDeps } from './structured-agent-session-usage-limit-continue-deps'

/** Whether the connector requests a usage-limit cut owes still wait for its automatic continue
 *  (Phase 1 §1.5). */
export type UsageLimitCutDisposition = 'pending' | 'ended' | 'ambiguous'

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
