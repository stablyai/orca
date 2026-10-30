import { translate, type Translate } from '../i18n/mobile-i18n'

export function localizedPushCount(count: number, t: Translate = translate): string {
  return count === 1
    ? t('sourceControl.dropdownCounts.pushCount_one', 'Push {{count}} commit', { count })
    : t('sourceControl.dropdownCounts.pushCount_other', 'Push {{count}} commits', { count })
}

export function localizedPullCount(count: number, t: Translate = translate): string {
  return count === 1
    ? t('sourceControl.dropdownCounts.pullCount_one', 'Pull {{count}} commit', { count })
    : t('sourceControl.dropdownCounts.pullCount_other', 'Pull {{count}} commits', { count })
}

export function localizedFastForwardCount(count: number, t: Translate = translate): string {
  return count === 1
    ? t('sourceControl.dropdownCounts.fastForwardCount_one', 'Fast-forward {{count}} commit', {
        count
      })
    : t('sourceControl.dropdownCounts.fastForwardCount_other', 'Fast-forward {{count}} commits', {
        count
      })
}

export function localizedSyncCounts(
  ahead: number,
  behind: number,
  t: Translate = translate
): string {
  return t('sourceControl.dropdownCounts.syncCounts', 'Pull {{behind}}, push {{ahead}}', {
    ahead,
    behind
  })
}

function localizedUpstreamName(upstreamName: string | undefined, t: Translate): string {
  return upstreamName ?? t('sourceControl.dropdownCounts.remoteBranchFallback', 'the remote branch')
}

export function localizedForcePushWithLease(
  branchCommitsAhead: number | undefined,
  upstreamName: string | undefined,
  t: Translate = translate
): string {
  const target = localizedUpstreamName(upstreamName, t)
  if (!branchCommitsAhead || branchCommitsAhead <= 0) {
    return t(
      'sourceControl.dropdownCounts.titleForcePushOlderCopiesBranch',
      'Remote only has older copies of local commits. Force push this branch with lease to update {{upstreamName}}.',
      { upstreamName: target }
    )
  }
  const count = branchCommitsAhead
  return count === 1
    ? t(
        'sourceControl.dropdownCounts.titleForcePushOlderCopiesCount_one',
        'Remote only has older copies of local commits. Force push {{count}} branch commit with lease to update {{upstreamName}}.',
        { count, upstreamName: target }
      )
    : t(
        'sourceControl.dropdownCounts.titleForcePushOlderCopiesCount_other',
        'Remote only has older copies of local commits. Force push {{count}} branch commits with lease to update {{upstreamName}}.',
        { count, upstreamName: target }
      )
}

export function localizedManualForcePush(
  ahead: number,
  behind: number,
  upstreamName: string | undefined,
  t: Translate = translate
): string {
  const count = ahead
  const target = localizedUpstreamName(upstreamName, t)
  if (behind > 0) {
    return count === 1
      ? t(
          'sourceControl.dropdownCounts.titleManualForcePushReplaceRemote_one',
          'Force push {{count}} local commit with lease to update {{upstreamName}} and replace remote-only commits.',
          { count, upstreamName: target }
        )
      : t(
          'sourceControl.dropdownCounts.titleManualForcePushReplaceRemote_other',
          'Force push {{count}} local commits with lease to update {{upstreamName}} and replace remote-only commits.',
          { count, upstreamName: target }
        )
  }
  return count === 1
    ? t(
        'sourceControl.dropdownCounts.titleManualForcePush_one',
        'Force push {{count}} local commit with lease to update {{upstreamName}}.',
        { count, upstreamName: target }
      )
    : t(
        'sourceControl.dropdownCounts.titleManualForcePush_other',
        'Force push {{count}} local commits with lease to update {{upstreamName}}.',
        { count, upstreamName: target }
      )
}

export function localizedUnpublishedForcePush(
  branchCommitsAhead: number | undefined,
  t: Translate = translate
): string {
  if (!branchCommitsAhead || branchCommitsAhead <= 0) {
    return t(
      'sourceControl.dropdownCounts.titleUnpublishedForcePushBranch',
      'Force push this branch with lease and set an upstream if needed.'
    )
  }
  const count = branchCommitsAhead
  return count === 1
    ? t(
        'sourceControl.dropdownCounts.titleUnpublishedForcePushCount_one',
        'Force push {{count}} branch commit with lease and set an upstream if needed.',
        { count }
      )
    : t(
        'sourceControl.dropdownCounts.titleUnpublishedForcePushCount_other',
        'Force push {{count}} branch commits with lease and set an upstream if needed.',
        { count }
      )
}
