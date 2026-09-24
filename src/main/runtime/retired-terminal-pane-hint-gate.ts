import { randomUUID } from 'node:crypto'
import { isTerminalLeafId } from '../../shared/stable-pane-id'
import { isValidHostTerminalTabId } from '../../shared/terminal-tab-id'
import type { RetiredTerminalPaneLedger } from './retired-terminal-pane-ledger'

/** What the host answers a create that hints a pane it already retired. No client retries it:
 *  an updated one settles the pane as absent, an older one surfaces the token as an error. */
export const RETIRED_TERMINAL_PANE_HINT_ERROR = 'tab_not_found'

/**
 * The pane identity a create commits to: the caller's hinted ids when the host may adopt them, a
 * fresh pair otherwise. Throws for a hint naming a pane the host retired — refusing rather than
 * minting a fresh id because a fresh id still spawns the shell, which is the user-visible bug
 * (#21341: tabs the host user closed came back on every client wake).
 *
 * Retirement needs both halves of the evidence. The ledger alone also covers a shell that exited
 * under a tab the user kept open, and that pane must still restart in place once the host
 * republishes it; absence alone cannot tell a retired pane from a client-minted id the host has
 * never seen, which is the normal shape of a paired client's first create.
 *
 * Reads the ledger without clearing it: only a PTY that actually bound to the pane may do that, and
 * a spawn between here and there can still fail.
 */
export function resolveHintedTerminalPaneIdentity(
  hint: { tabId?: string; leafId?: string },
  host: {
    worktreeId: string
    retiredPanes: RetiredTerminalPaneLedger
    isSurfacePublished: (tabId: string, leafId: string) => boolean
  }
): { tabId: string; leafId: string } {
  const hintedTabId = hint.tabId?.trim()
  const hintedLeafId = hint.leafId
  if (
    hintedTabId === undefined ||
    !isValidHostTerminalTabId(hintedTabId) ||
    hintedLeafId === undefined ||
    !isTerminalLeafId(hintedLeafId)
  ) {
    return { tabId: randomUUID(), leafId: randomUUID() }
  }
  if (
    host.retiredPanes.has(host.worktreeId, hintedTabId, hintedLeafId) &&
    !host.isSurfacePublished(hintedTabId, hintedLeafId)
  ) {
    throw new Error(RETIRED_TERMINAL_PANE_HINT_ERROR)
  }
  return { tabId: hintedTabId, leafId: hintedLeafId }
}
