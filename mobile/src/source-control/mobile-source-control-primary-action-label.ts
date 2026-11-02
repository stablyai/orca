import { translate } from '../i18n/mobile-i18n'
import type { SourceControlCommitAreaPrimaryActionDecision } from '../../../src/shared/source-control-primary-action-decision'

// "Commit 2 files", "Push 3 commits": the commit area's action named with its count.
export function getMobilePrimaryActionLabel(
  decision: SourceControlCommitAreaPrimaryActionDecision,
  stagedCount: number
): string {
  if (decision.requiresForceWithLease) {
    return translate('sourceControl.primaryAction.forcePush', 'Force Push')
  }
  switch (decision.kind) {
    case 'commit':
      return countLabel(stagedCount, {
        none: () => translate('sourceControl.primaryAction.commit', 'Commit'),
        one: (count) =>
          translate('sourceControl.primaryAction.commitFiles_one', 'Commit {{count}} file', {
            count
          }),
        other: (count) =>
          translate('sourceControl.primaryAction.commitFiles_other', 'Commit {{count}} files', {
            count
          })
      })
    case 'stage':
      return translate('sourceControl.primaryAction.stageAll', 'Stage all')
    case 'push':
      return countLabel(decision.count, {
        none: () => translate('sourceControl.primaryAction.push', 'Push'),
        one: (count) =>
          translate('sourceControl.primaryAction.pushCommits_one', 'Push {{count}} commit', {
            count
          }),
        other: (count) =>
          translate('sourceControl.primaryAction.pushCommits_other', 'Push {{count}} commits', {
            count
          })
      })
    case 'pull':
      return countLabel(decision.count, {
        none: () => translate('sourceControl.primaryAction.pull', 'Pull'),
        one: (count) =>
          translate('sourceControl.primaryAction.pullCommits_one', 'Pull {{count}} commit', {
            count
          }),
        other: (count) =>
          translate('sourceControl.primaryAction.pullCommits_other', 'Pull {{count}} commits', {
            count
          })
      })
    case 'sync':
      return translate('sourceControl.primaryAction.sync', 'Sync')
    case 'publish':
      return translate('sourceControl.primaryAction.publishBranch', 'Publish Branch')
  }
}

function countLabel(
  count: number | undefined,
  labels: { none: () => string; one: (count: number) => string; other: (count: number) => string }
): string {
  if (!count || count < 1) {
    return labels.none()
  }
  return count === 1 ? labels.one(count) : labels.other(count)
}
