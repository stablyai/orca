import type { TerminalSurfaceCloseCapture } from '../../shared/terminal-tab-close'
import type {
  RuntimeMobileSessionTabCloseResult,
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeSessionTabCloseReason
} from '../../shared/runtime-types'
import type { RuntimePtyTabCloseAuthority } from './runtime-terminal-state-records'
import type { ClientSessionTabSelectionStore } from './client-session-tab-selection'

// Tombstones hide tabs until activation; only proven host retirement may hide a still-published tab.

// Type-only brand adds no field to mixed-version RPC replies.
declare const mobileSessionTabCloseOutcomeBrand: unique symbol

// Require each close return site to choose an outcome constructor.
export type MobileSessionTabCloseOutcome = RuntimeMobileSessionTabCloseResult & {
  readonly [mobileSessionTabCloseOutcomeBrand]: never
}

type MobileSessionTabCloseRefusalReason = NonNullable<
  RuntimeMobileSessionTabCloseResult['refusalReason']
>

// Couple verified host retirement with its selection tombstone here to prevent drift.
export function committedMobileSessionTabClose(
  selections: Pick<ClientSessionTabSelectionStore, 'forgetTabs'>,
  worktreeId: string,
  closedTabIds: readonly string[]
): MobileSessionTabCloseOutcome {
  selections.forgetTabs(worktreeId, closedTabIds)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only this constructor brands the outcome after committed retirement.
  return { closed: true, retirementConfirmed: true } as MobileSessionTabCloseOutcome
}

// Renderer notifications are unacknowledged and may be declined; delegated close must never tombstone.
export function delegatedMobileSessionTabClose(): MobileSessionTabCloseOutcome {
  return { closed: true } as MobileSessionTabCloseOutcome
}

// Refusal sites choose whether to restore a client's pruned mirror via snapshotRepublished.
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

/** What retiring one terminal pane may carry: its captured presentation and proofs. */
export type TerminalPaneRetirementOptions = Pick<
  MobileSessionTabCloseOptions,
  'originalPresentation' | 'rendererOwnsPresentation' | 'retirementProofs' | 'presentationRetired'
>

export type MobileSessionTabCloseOptions = {
  originalPresentation?: TerminalSurfaceCloseCapture
  rendererOwnsPresentation?: boolean
  retirementProofs?: RuntimeMobileSessionRetiredTerminalSurface[]
  /** The pane's presentation is already gone (a replace's write or its own exit); retire only its bookkeeping. */
  presentationRetired?: boolean
  reason?: RuntimeSessionTabCloseReason
  expectedPublicationEpoch?: string
  expectedTerminalHandle?: string
  clientNavigationId?: string
  localPtyTeardownOwnedExternally?: boolean
  expectedPtyCloseAuthority?: RuntimePtyTabCloseAuthority
  force?: boolean
}
