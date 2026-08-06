import type { MobileGitUpstreamStatus } from './mobile-git-status'
import { t } from '@/i18n/mobile-i18n'

// Icon identifier resolved to a lucide component by the screen. Kept as a string
// here so this module stays free of the native lucide import and unit-testable.
export type MobileSourceControlActionIcon =
  | 'commit'
  | 'push'
  | 'pull'
  | 'sync'
  | 'fetch'
  | 'publish'
  | 'rebase'
  | 'pr'
  | 'branch'
  | 'history'

export type MobileSourceControlAction = {
  label: string
  iconKey: MobileSourceControlActionIcon
  disabled?: boolean
  hint?: string
  loading?: boolean
  skipAutoClose?: boolean
  onPress: () => void
}

export type MobileSourceControlActionArgs = {
  commitMessage: string
  stagedCount: number
  upstream: MobileGitUpstreamStatus | null
  upstreamKnown: boolean
  busyAction: string | null
  openingPath: string | null
  openingBranchPath: string | null
  prAvailable: boolean
  handlers: {
    commit: () => void
    commitPush: () => void
    commitSync: () => void
    push: () => void
    pull: () => void
    sync: () => void
    fetch: () => void
    publish: () => void
    fastForward: () => void
    rebase: () => void
    createPr: () => void
    pushAndCreatePr: () => void
    checkout: () => void
    history: () => void
  }
}

// Builds the source-control bottom-sheet action list. Pure (no hooks) so it can
// be unit-tested and keeps the screen file lean. Enable/disable rules mirror the
// desktop primary-action gating.
export function buildMobileSourceControlActions(
  args: MobileSourceControlActionArgs
): MobileSourceControlAction[] {
  const { commitMessage, stagedCount, upstream, upstreamKnown, handlers } = args
  const hasMessage = commitMessage.trim().length > 0
  const hasStaged = stagedCount > 0
  const hasUpstream = upstream?.hasUpstream === true
  const ahead = upstream?.ahead ?? 0
  const behind = upstream?.behind ?? 0
  const busy =
    args.busyAction !== null || args.openingPath !== null || args.openingBranchPath !== null
  const commitHint = !hasStaged
    ? t('mobileSourceControlActions.stage')
    : !hasMessage
      ? t('mobileSourceControlActions.enter')
      : undefined
  const remoteHint = !upstreamKnown
    ? t('mobileSourceControlActions.checking')
    : hasUpstream
      ? undefined
      : t('mobileSourceControlActions.publishBranchFirst')
  const prHint = !upstreamKnown
    ? t('mobileSourceControlActions.checking')
    : !args.prAvailable
      ? t('mobileSourceControlActions.pullRequests')
      : undefined

  return [
    {
      label: t('mobileSourceControlActions.commit'),
      iconKey: 'commit',
      disabled: busy || !!commitHint,
      hint: commitHint,
      loading: args.busyAction === 'commit',
      skipAutoClose: true,
      onPress: handlers.commit
    },
    {
      label: t('mobileSourceControlActions.commitPush'),
      iconKey: 'push',
      disabled: busy || !!commitHint || !upstreamKnown || !hasUpstream,
      hint: commitHint ?? remoteHint,
      loading: args.busyAction === 'commit-push',
      skipAutoClose: true,
      onPress: handlers.commitPush
    },
    {
      label: t('mobileSourceControlActions.commitSync'),
      iconKey: 'sync',
      disabled: busy || !!commitHint || !upstreamKnown || !hasUpstream || behind === 0,
      hint:
        commitHint ??
        (!upstreamKnown || !hasUpstream
          ? remoteHint
          : behind === 0
            ? t('mobileSourceControlActions.nothingPull')
            : undefined),
      loading: args.busyAction === 'commit-sync',
      skipAutoClose: true,
      onPress: handlers.commitSync
    },
    {
      label:
        ahead > 0
          ? t('mobileSourceControlActions.pushAhead', {
              aheadCommitCount: ahead
            })
          : t('mobileSourceControlActions.push'),
      iconKey: 'push',
      disabled: busy || !upstreamKnown || !hasUpstream || ahead === 0,
      hint: !hasUpstream
        ? remoteHint
        : ahead === 0
          ? t('mobileSourceControlActions.nothingPush')
          : undefined,
      loading: args.busyAction === 'push',
      skipAutoClose: true,
      onPress: handlers.push
    },
    {
      label: t('mobileSourceControlActions.create'),
      iconKey: 'pr',
      disabled: busy || !args.prAvailable,
      hint: prHint,
      loading: args.busyAction === 'create-pr',
      skipAutoClose: true,
      onPress: handlers.createPr
    },
    {
      label: t('mobileSourceControlActions.pushCreate'),
      iconKey: 'pr',
      disabled: busy || !upstreamKnown || !hasUpstream || ahead === 0 || !args.prAvailable,
      hint: prHint ?? (!hasUpstream ? remoteHint : undefined),
      loading: args.busyAction === 'push-create-pr',
      skipAutoClose: true,
      onPress: handlers.pushAndCreatePr
    },
    {
      label:
        behind > 0
          ? t('mobileSourceControlActions.pullBehind', {
              behindCommitCount: behind
            })
          : t('mobileSourceControlActions.pull'),
      iconKey: 'pull',
      disabled: busy || !upstreamKnown || !hasUpstream || behind === 0,
      hint: !hasUpstream
        ? remoteHint
        : behind === 0
          ? t('mobileSourceControlActions.nothingPull')
          : undefined,
      loading: args.busyAction === 'pull',
      skipAutoClose: true,
      onPress: handlers.pull
    },
    {
      label:
        ahead > 0 || behind > 0
          ? t('mobileSourceControlActions.syncBehind', {
              behindCommitCount: behind,
              aheadCommitCount: ahead
            })
          : t('mobileSourceControlActions.sync'),
      iconKey: 'sync',
      disabled: busy || !upstreamKnown || !hasUpstream || (ahead === 0 && behind === 0),
      hint:
        !upstreamKnown || !hasUpstream
          ? remoteHint
          : ahead === 0 && behind === 0
            ? t('mobileSourceControlActions.branchUp')
            : undefined,
      loading: args.busyAction === 'sync',
      skipAutoClose: true,
      onPress: handlers.sync
    },
    {
      label: t('mobileSourceControlActions.fetch'),
      iconKey: 'fetch',
      disabled: busy,
      loading: args.busyAction === 'fetch',
      skipAutoClose: true,
      onPress: handlers.fetch
    },
    {
      label: t('mobileSourceControlActions.publishBranch'),
      iconKey: 'publish',
      disabled: busy || !upstreamKnown || hasUpstream,
      hint: !upstreamKnown
        ? t('mobileSourceControlActions.checking')
        : hasUpstream
          ? t('mobileSourceControlActions.branchAlready')
          : undefined,
      loading: args.busyAction === 'publish',
      skipAutoClose: true,
      onPress: handlers.publish
    },
    {
      label:
        behind > 0
          ? t('mobileSourceControlActions.fastForwardBehind', {
              behindCommitCount: behind
            })
          : t('mobileSourceControlActions.fastForward'),
      iconKey: 'pull',
      disabled: busy || !upstreamKnown || !hasUpstream || behind === 0 || ahead > 0,
      hint: !hasUpstream
        ? remoteHint
        : behind === 0
          ? t('mobileSourceControlActions.nothingFast')
          : ahead > 0
            ? t('mobileSourceControlActions.local')
            : undefined,
      loading: args.busyAction === 'fast-forward',
      skipAutoClose: true,
      onPress: handlers.fastForward
    },
    {
      label: t('mobileSourceControlActions.rebase'),
      iconKey: 'branch',
      disabled: busy,
      loading: args.busyAction === 'rebase',
      skipAutoClose: true,
      onPress: handlers.rebase
    },
    {
      label: t('mobileSourceControlActions.switch'),
      iconKey: 'branch',
      disabled: busy,
      skipAutoClose: true,
      onPress: handlers.checkout
    },
    {
      label: t('mobileSourceControlActions.commits'),
      iconKey: 'history',
      disabled: busy,
      onPress: handlers.history
    }
  ]
}
