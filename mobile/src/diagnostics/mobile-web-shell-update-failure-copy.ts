import type { MobileWebBundleErrorCode } from '../../../src/shared/mobile-web-bundle/bundle-rpc-contract'
import { BUILD_ID_PREFIX_LENGTH } from '../mobile-web-shell/mobile-web-shell-dev-facts'
import type {
  MobileWebShellUpdateFailure,
  MobileWebShellUpdateFailureOutcome,
  MobileWebShellUpdateFailureReason,
  MobileWebShellUpdateFailureWall
} from '../mobile-web-shell/mobile-web-shell-update-failure'
import { formatTimeAgo } from '../worktree/agent-row-display'

/** Each phrase restates the recorded code and nothing more: this row claims only what was written. */
const REASON_COPY: Record<MobileWebShellUpdateFailureReason, string> = {
  'no-connection': 'not connected to the host',
  'connection-lost': 'the connection dropped',
  'host-refused': 'the host refused the read',
  'reply-unreadable': 'the host sent a reply this app could not read',
  'chunk-oversize': 'a chunk was larger than the host allows',
  'asset-overlong': 'an asset was longer than the manifest declares',
  'asset-no-progress': 'an asset read made no progress',
  'asset-short': 'an asset ended short of its declared size',
  'asset-checksum-mismatch': 'asset checksum mismatch',
  'build-changed-mid-fetch': "the host's build changed during the download",
  'chunk-misrouted': 'a chunk answered the wrong asset or offset',
  'asset-entry-changed': 'an asset no longer matched the manifest',
  'range-undecodable': 'a compressed read could not be decoded',
  'fetch-stopped': 'the download was stopped',
  'cache-write-failed': 'saving the download on this phone failed',
  'unrecognised-error': 'an unrecognised error'
}

const HOST_CODE_COPY: Record<MobileWebBundleErrorCode, string> = {
  mobile_web_bundle_unavailable: 'the host has no workspace bundle',
  mobile_web_bundle_build_changed: "the host's build changed during the download",
  mobile_web_bundle_asset_unknown: 'the host did not recognise an asset',
  mobile_web_bundle_asset_changed: 'an asset changed on the host',
  mobile_web_bundle_offset_invalid: 'the host refused a read offset',
  mobile_web_bundle_read_limited: 'the host limited concurrent reads'
}

const WALL_COPY: Record<MobileWebShellUpdateFailureWall, string> = {
  'bundle-unavailable': 'the host has no workspace bundle',
  'bundle-shell-too-old': 'this app is too old for the saved bundle',
  'host-too-old-for-bundle': 'the host is too old for the saved bundle',
  'bundle-too-old-for-host': 'the saved bundle is too old for the host'
}

function generation(buildId: string): string {
  return `${buildId.slice(0, BUILD_ID_PREFIX_LENGTH)}…`
}

function outcomeCopy(failure: MobileWebShellUpdateFailure): string {
  const outcome: MobileWebShellUpdateFailureOutcome = failure.outcome
  switch (outcome) {
    case 'opened-cached':
      return failure.cachedBuildId === null
        ? 'Fell back to the saved version.'
        : `Fell back to the saved version (generation ${generation(failure.cachedBuildId)}).`
    case 'wall':
      return failure.wall === null
        ? 'Blocked the workspace.'
        : `Blocked: ${WALL_COPY[failure.wall]}.`
    case 'native-route':
      return 'Showed the native screen.'
    case 'failed':
      return 'Showed the failure screen.'
    case 'waiting':
      return 'Waited for the host.'
  }
}

/** "Last update from Host 1 failed 12m ago: asset checksum mismatch (generation 3f2a…)." plus what
 *  the shell showed instead. */
export function formatUpdateFailure(
  failure: MobileWebShellUpdateFailure,
  hostName: string,
  now: number
): string {
  const ago = formatTimeAgo(failure.at, now)
  const when = ago === 'just now' ? ago : `${ago} ago`
  const reason =
    failure.hostCode === null ? REASON_COPY[failure.reason] : HOST_CODE_COPY[failure.hostCode]
  const offered =
    failure.offeredBuildId === null ? '' : ` (generation ${generation(failure.offeredBuildId)})`
  return `Last update from ${hostName} failed ${when}: ${reason}${offered}. ${outcomeCopy(failure)}`
}
