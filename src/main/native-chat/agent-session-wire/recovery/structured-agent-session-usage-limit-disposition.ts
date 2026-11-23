import type { HostUsageLimitCut, SwitchReset } from './structured-agent-session-usage-limit-chain'
import { USAGE_LIMIT_CONTINUE_CHAIN_LIMIT } from './structured-agent-session-usage-limit-chain'

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

type Cancel = { turnItemId: string; resetsAt: number } | undefined

/** A person's cancel of this very cut. A switch's time is not kept, so its cut matches by turn. */
export const cancelsCut = (
  cancel: Cancel,
  cut: Pick<HostUsageLimitCut, 'turnItemId' | 'resetsAt'> & SwitchReset
) =>
  cancel?.turnItemId === cut.turnItemId &&
  (cut.resetFromSwitch === true || cancel.resetsAt === cut.resetsAt)

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
