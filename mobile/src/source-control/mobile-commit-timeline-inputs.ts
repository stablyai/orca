import { useEffect, useMemo, useRef } from 'react'
import { formatSourceControlRefLabel } from '../../../src/shared/source-control-ref-label'
import type { GitHistoryUpstreamVerdict } from '../../../src/shared/git-history-push-state'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import {
  buildMobileSourceControlPrimaryAction,
  type MobileSourceControlPrimaryAction,
  type MobileSourceControlPrimaryActionArgs,
  type MobileSourceControlReviewInputs
} from './mobile-source-control-primary-action'
import type { MobileBranchCompareState, ScreenState } from './mobile-source-control-screen-state'
import type { MobileGitStatusEntry } from './git-status-reply-schema'
import type { MobileTimelineBase, MobileTimelineUncommitted } from './MobileCommitTimelineRows'

export type MobileCommitTimelineInputs = {
  // False while status or the branch compare is still loading, so the first history read already names its base.
  settled: boolean
  baseRef: string | null
  baseMergeBase: string | null
  base: MobileTimelineBase | null
  headKey: string
  upstream: GitHistoryUpstreamVerdict | null
  uncommitted: MobileTimelineUncommitted | null
  pushAction: MobileSourceControlPrimaryAction | null
}

type InputsArgs = {
  screenState: ScreenState
  branchCompareState: MobileBranchCompareState
  primaryActionArgs: MobileSourceControlPrimaryActionArgs
  review: MobileSourceControlReviewInputs
  actionSheetActions: readonly ActionSheetAction[]
}

function sumLineStats(
  entries: readonly MobileGitStatusEntry[],
  field: 'added' | 'removed'
): number | null {
  // Line stats arrive after first paint, or never on hosts that skip them.
  const counted = entries.filter(
    (entry) => entry.added !== undefined || entry.removed !== undefined
  )
  return counted.length ? counted.reduce((sum, entry) => sum + (entry[field] ?? 0), 0) : null
}

// Desktop's remote rule for the branch as committed: what the primary button offers once nothing is left to commit.
function buildRemoteAction(args: InputsArgs): MobileSourceControlPrimaryAction | null {
  const action = buildMobileSourceControlPrimaryAction({
    ...args.primaryActionArgs,
    review: args.review,
    stagedCount: 0,
    stageablePaths: [],
    unstagedCount: 0,
    commitMessage: ''
  })
  return action.kind === 'push' || action.kind === 'sync' || action.kind === 'publish'
    ? action
    : null
}

// Values keyed on primitives: commit-message keystrokes rebuild the commit area but must not re-render the hidden timeline.
export function useMobileCommitTimelineInputs(args: InputsArgs): MobileCommitTimelineInputs {
  const status = args.screenState.kind === 'ready' ? args.screenState.status : null
  const compare =
    args.branchCompareState.kind === 'ready' ? args.branchCompareState.result.summary : null
  const readyCompare = compare?.status === 'ready' ? compare : null
  const upstream = status?.upstreamStatus
  const remote = buildRemoteAction(args)
  const update = args.actionSheetActions.find((action) => action.id === 'rebase') ?? null
  const latest = useRef({ remote, update })
  useEffect(() => {
    latest.current = { remote, update }
  })

  const kind = remote?.kind ?? null
  const label = remote?.label ?? ''
  const hint = remote?.accessibilityHint ?? ''
  const disabled = remote?.disabled ?? true
  const loading = remote?.loading ?? false
  const forceWithLease = remote?.requiresForceWithLease
  const pushAction = useMemo<MobileSourceControlPrimaryAction | null>(
    () =>
      kind === null
        ? null
        : {
            kind,
            label,
            accessibilityLabel: label,
            accessibilityHint: hint,
            disabled,
            loading,
            requiresForceWithLease: forceWithLease,
            onPress: () => latest.current.remote?.onPress()
          },
    [disabled, forceWithLease, hint, kind, label, loading]
  )

  const baseLabel = readyCompare ? formatSourceControlRefLabel(readyCompare.baseRef) : null
  const commitsBehind = readyCompare?.commitsBehind ?? null
  const updateLabel = update?.label ?? null
  const updateDisabled = update?.disabled ?? false
  const updateHint = update?.hint
  const updateLoading = update?.loading ?? false
  const base = useMemo<MobileTimelineBase | null>(
    () =>
      baseLabel === null
        ? null
        : {
            label: baseLabel,
            commitsBehind,
            update:
              updateLabel === null
                ? null
                : {
                    id: 'rebase',
                    label: updateLabel,
                    disabled: updateDisabled,
                    hint: updateHint,
                    loading: updateLoading,
                    onPress: () => latest.current.update?.onPress()
                  }
          },
    [baseLabel, commitsBehind, updateDisabled, updateHint, updateLabel, updateLoading]
  )

  const entries = status?.entries
  // Keyed on entries: typing a commit message re-renders the panel without changing them.
  const { fileCount, insertions, deletions } = useMemo(
    () => ({
      fileCount: entries ? new Set(entries.map((entry) => entry.path)).size : null,
      insertions: entries ? sumLineStats(entries, 'added') : null,
      deletions: entries ? sumLineStats(entries, 'removed') : null
    }),
    [entries]
  )
  const uncommitted = useMemo(
    () => (fileCount === null ? null : { fileCount, insertions, deletions }),
    [deletions, fileCount, insertions]
  )

  const hasUpstream = upstream?.hasUpstream
  const ahead = upstream?.ahead ?? 0
  const upstreamVerdict = useMemo(
    () => (hasUpstream === undefined ? null : { hasUpstream, ahead }),
    [ahead, hasUpstream]
  )

  return {
    upstream: upstreamVerdict,
    settled: args.screenState.kind !== 'loading' && args.branchCompareState.kind !== 'loading',
    baseRef: readyCompare?.baseRef ?? null,
    baseMergeBase: readyCompare?.mergeBase ?? null,
    base,
    headKey: [
      status?.head,
      upstream?.hasUpstream,
      upstream?.ahead,
      upstream?.behind,
      readyCompare?.mergeBase
    ].join(':'),
    uncommitted,
    pushAction
  }
}
