import type { RuntimeMobileSessionTabCloseResult } from '../../shared/runtime-types'
import type { ClientSessionTabSelectionStore } from './client-session-tab-selection'

// Why: a selection tombstone (ClientSessionTabSelectionStore.forgetTabs) is not a
// hint — it filters the tab out of every snapshot published to that client, and
// only activating the tab clears it. So it is a claim that the host itself
// authoritatively retired the tab while its own published snapshot still lists
// it. Claiming that for a close the host merely asked someone else to perform
// would hide a still-live tab from a paired client with no recovery path.
// Hence the three outcome classes below, one constructor each.

// Why: declared, never assigned — the brand exists only in the type system, so
// no new field reaches mixed-version clients over the RPC wire.
declare const mobileSessionTabCloseOutcomeBrand: unique symbol

// Why: the required brand makes a bare `{ closed: true }` unassignable, forcing
// every close return site to name which outcome class it is.
export type MobileSessionTabCloseOutcome = RuntimeMobileSessionTabCloseResult & {
  readonly [mobileSessionTabCloseOutcomeBrand]: never
}

type MobileSessionTabCloseRefusalReason = NonNullable<
  RuntimeMobileSessionTabCloseResult['refusalReason']
>

// Why: the host tore the tab down (or verified its teardown) itself, so it may
// tombstone the client's selection. The tombstone is written here, not by the
// caller, so this outcome's name and its effect cannot drift apart.
export function committedMobileSessionTabClose(
  selections: Pick<ClientSessionTabSelectionStore, 'forgetTabs'>,
  worktreeId: string,
  closedTabIds: readonly string[]
): MobileSessionTabCloseOutcome {
  selections.forgetTabs(worktreeId, closedTabIds)
  return { closed: true } as MobileSessionTabCloseOutcome
}

// Why: the close was handed to the renderer over a fire-and-forget notifier that
// carries no acknowledgement. The renderer may legitimately decline it — an
// unresolvable worktree route, or a pinned-tab confirm the user cancels — so the
// host does not know the tab retired and must not tombstone it.
export function delegatedMobileSessionTabClose(): MobileSessionTabCloseOutcome {
  return { closed: true } as MobileSessionTabCloseOutcome
}

// Why: `snapshotRepublished` tells the client to restore its pruned mirror, so it
// is passed explicitly per site — some refusals deliberately skip the republish.
export function refusedMobileSessionTabClose(
  refusalReason: MobileSessionTabCloseRefusalReason,
  options: { snapshotRepublished?: boolean } = {}
): MobileSessionTabCloseOutcome {
  return {
    closed: true,
    refused: true,
    refusalReason,
    ...(options.snapshotRepublished ? { snapshotRepublished: true as const } : {})
  } as MobileSessionTabCloseOutcome
}
