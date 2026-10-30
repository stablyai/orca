import type { MobileWebBundleErrorCode } from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import { BUILD_ID_PREFIX_LENGTH } from '../mobile-web-shell/mobile-web-shell-dev-facts'
import type {
  MobileWebShellUpdateFailure,
  MobileWebShellUpdateFailureOutcome,
  MobileWebShellUpdateFailureReason,
  MobileWebShellUpdateFailureWall
} from '../mobile-web-shell/mobile-web-shell-update-failure'
import { formatTimeAgo } from '../worktree/agent-row-display'
import { translate } from '../i18n/mobile-i18n'

// Describe only the recorded code; this row has no further evidence about the failure.
function reasonCopy(): Record<MobileWebShellUpdateFailureReason, string> {
  return {
    'no-connection': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.noConnection',
      'not connected to the host'
    ),
    'connection-lost': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.connectionLost',
      'the connection dropped'
    ),
    'host-refused': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.hostRefused',
      'the host refused the read'
    ),
    'reply-unreadable': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.replyUnreadable',
      'the host sent a reply this app could not read'
    ),
    'chunk-oversize': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.chunkOversize',
      'a chunk was larger than the host allows'
    ),
    'asset-overlong': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.assetOverlong',
      'an asset was longer than the manifest declares'
    ),
    'asset-no-progress': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.assetNoProgress',
      'an asset read made no progress'
    ),
    'asset-short': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.assetShort',
      'an asset ended short of its declared size'
    ),
    'asset-checksum-mismatch': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.assetChecksumMismatch',
      'asset checksum mismatch'
    ),
    'build-changed-mid-fetch': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.buildChangedMidFetch',
      "the host's build changed during the download"
    ),
    'chunk-misrouted': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.chunkMisrouted',
      'a chunk answered the wrong asset or offset'
    ),
    'asset-entry-changed': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.assetEntryChanged',
      'an asset no longer matched the manifest'
    ),
    'range-undecodable': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.rangeUndecodable',
      'a compressed read could not be decoded'
    ),
    'fetch-stopped': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.fetchStopped',
      'the download was stopped'
    ),
    'cache-write-failed': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.cacheWriteFailed',
      'saving the download on this phone failed'
    ),
    'unrecognised-error': translate(
      'diagnostics.webShellUpdateFailureCopy.reasonCopy.unrecognisedError',
      'an unrecognised error'
    )
  }
}

function hostCodeCopy(): Record<MobileWebBundleErrorCode, string> {
  return {
    mobile_web_bundle_unavailable: translate(
      'diagnostics.webShellUpdateFailureCopy.hostCodeCopy.unavailable',
      'the host has no workspace bundle'
    ),
    mobile_web_bundle_build_changed: translate(
      'diagnostics.webShellUpdateFailureCopy.hostCodeCopy.buildChanged',
      "the host's build changed during the download"
    ),
    mobile_web_bundle_asset_unknown: translate(
      'diagnostics.webShellUpdateFailureCopy.hostCodeCopy.assetUnknown',
      'the host did not recognise an asset'
    ),
    mobile_web_bundle_asset_changed: translate(
      'diagnostics.webShellUpdateFailureCopy.hostCodeCopy.assetChanged',
      'an asset changed on the host'
    ),
    mobile_web_bundle_offset_invalid: translate(
      'diagnostics.webShellUpdateFailureCopy.hostCodeCopy.offsetInvalid',
      'the host refused a read offset'
    ),
    mobile_web_bundle_read_limited: translate(
      'diagnostics.webShellUpdateFailureCopy.hostCodeCopy.readLimited',
      'the host limited concurrent reads'
    )
  }
}

function wallCopy(): Record<MobileWebShellUpdateFailureWall, string> {
  return {
    'bundle-unavailable': translate(
      'diagnostics.webShellUpdateFailureCopy.wallCopy.bundleUnavailable',
      'the host has no workspace bundle'
    ),
    'bundle-shell-too-old': translate(
      'diagnostics.webShellUpdateFailureCopy.wallCopy.bundleShellTooOld',
      'this app is too old for the saved bundle'
    ),
    'host-too-old-for-bundle': translate(
      'diagnostics.webShellUpdateFailureCopy.wallCopy.hostTooOldForBundle',
      'the host is too old for the saved bundle'
    ),
    'bundle-too-old-for-host': translate(
      'diagnostics.webShellUpdateFailureCopy.wallCopy.bundleTooOldForHost',
      'the saved bundle is too old for the host'
    ),
    'page-route-unlisted': translate(
      'diagnostics.webShellUpdateFailureCopy.wallCopy.pageRouteUnlisted',
      "the host's workspace does not include this screen"
    ),
    'page-route-grant-missing': translate(
      'diagnostics.webShellUpdateFailureCopy.wallCopy.pageRouteGrantMissing',
      'this screen needs a newer app'
    )
  }
}

function generation(buildId: string): string {
  return `${buildId.slice(0, BUILD_ID_PREFIX_LENGTH)}…`
}

function outcomeCopy(failure: MobileWebShellUpdateFailure): string {
  const outcome: MobileWebShellUpdateFailureOutcome = failure.outcome
  switch (outcome) {
    case 'opened-cached':
      return failure.cachedBuildId === null
        ? translate(
            'diagnostics.webShellUpdateFailureCopy.openedCached',
            'Fell back to the saved version.'
          )
        : translate(
            'diagnostics.webShellUpdateFailureCopy.openedCachedGeneration',
            'Fell back to the saved version (generation {{generation}}).',
            { generation: generation(failure.cachedBuildId) }
          )
    case 'wall':
      return failure.wall === null
        ? translate(
            'diagnostics.webShellUpdateFailureCopy.blockedWorkspace',
            'Blocked the workspace.'
          )
        : translate('diagnostics.webShellUpdateFailureCopy.blockedReason', 'Blocked: {{reason}}.', {
            reason: wallCopy()[failure.wall]
          })
    case 'native-route':
      return translate(
        'diagnostics.webShellUpdateFailureCopy.nativeRoute',
        'Showed the native screen.'
      )
    case 'route-unavailable':
      return translate(
        'diagnostics.webShellUpdateFailureCopy.routeUnavailable',
        'Showed that the screen is not available.'
      )
    case 'failed':
      return translate('diagnostics.webShellUpdateFailureCopy.failed', 'Showed the failure screen.')
    case 'waiting':
      return translate('diagnostics.webShellUpdateFailureCopy.waiting', 'Waited for the host.')
  }
}

export function formatUpdateFailure(
  failure: MobileWebShellUpdateFailure,
  hostName: string,
  now: number
): string {
  const reason =
    failure.hostCode === null ? reasonCopy()[failure.reason] : hostCodeCopy()[failure.hostCode]
  const offered =
    failure.offeredBuildId === null
      ? ''
      : translate(
          'diagnostics.webShellUpdateFailureCopy.offeredGeneration',
          ' (generation {{generation}})',
          { generation: generation(failure.offeredBuildId) }
        )
  const options = { hostName, reason, offered, outcome: outcomeCopy(failure) }
  return now - failure.at < 60_000
    ? translate(
        'diagnostics.webShellUpdateFailureCopy.failedJustNow',
        'Last update from {{hostName}} failed just now: {{reason}}{{offered}}. {{outcome}}',
        options
      )
    : translate(
        'diagnostics.webShellUpdateFailureCopy.failedAgo',
        'Last update from {{hostName}} failed {{time}} ago: {{reason}}{{offered}}. {{outcome}}',
        { ...options, time: formatTimeAgo(failure.at, now) }
      )
}
