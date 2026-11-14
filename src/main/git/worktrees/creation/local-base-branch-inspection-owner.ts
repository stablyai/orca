import { InFlightPromiseDedupe } from '../../../../shared/in-flight-promise-dedupe'
import type { LocalBaseBranchInspection } from '../../../../shared/worktree/base-refs/local-base-branch-fast-forward'
import { subscribeGitRefChanges } from '../../refs/git-ref-change-signal'

// Each Git read has a deadline; slow inspections must stay shared until they settle.
export const localBaseBranchInspectionOwner = new InFlightPromiseDedupe<LocalBaseBranchInspection>(
  0
)

// Includes fetches that do not use source-control's mutation wrapper.
subscribeGitRefChanges(null, () => localBaseBranchInspectionOwner.clear())
