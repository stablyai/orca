import type { Translate } from '../../i18n/mobile-i18n'
import type { SourceControlCommitAreaPrimaryActionDecision } from '../../../../src/shared/source-control/decisions/source-control-primary-action-decision-types'

// "Commit 2 files", "Push 3 commits": the commit area's action named with its count.
export function getMobilePrimaryActionLabel(
  decision: SourceControlCommitAreaPrimaryActionDecision,
  stagedCount: number,
  t: Translate
): string {
  if (decision.requiresForceWithLease) {
    return t('sourceControl.primaryAction.forcePush', 'Force Push')
  }
  switch (decision.kind) {
    case 'commit':
      return countLabel(stagedCount, {
        none: () => t('sourceControl.primaryAction.commit', 'Commit'),
        one: (count) =>
          t('sourceControl.primaryAction.commitFiles_one', 'Commit {{count}} file', {
            count
          }),
        other: (count) =>
          t('sourceControl.primaryAction.commitFiles_other', 'Commit {{count}} files', {
            count
          })
      })
    case 'stage':
      return t('sourceControl.primaryAction.stageAll', 'Stage all')
    case 'push':
      return countLabel(decision.count, {
        none: () => t('sourceControl.primaryAction.push', 'Push'),
        one: (count) =>
          t('sourceControl.primaryAction.pushCommits_one', 'Push {{count}} commit', {
            count
          }),
        other: (count) =>
          t('sourceControl.primaryAction.pushCommits_other', 'Push {{count}} commits', {
            count
          })
      })
    case 'pull':
      return countLabel(decision.count, {
        none: () => t('sourceControl.primaryAction.pull', 'Pull'),
        one: (count) =>
          t('sourceControl.primaryAction.pullCommits_one', 'Pull {{count}} commit', {
            count
          }),
        other: (count) =>
          t('sourceControl.primaryAction.pullCommits_other', 'Pull {{count}} commits', {
            count
          })
      })
    case 'sync':
      return t('sourceControl.primaryAction.sync', 'Sync')
    case 'publish':
      return t('sourceControl.primaryAction.publishBranch', 'Publish Branch')
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
