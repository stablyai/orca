import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { getMainHttpClient } from '../../../network/http-client'
import {
  ReleaseAssetPolicyLiveUpdater,
  type ReleaseAssetPolicySpec
} from '../../../remote-policies/release-asset-policy-live-update'
import {
  CODEX_HISTORY_CLEANUP_POLICY_MAX_BYTES,
  authoritativeDownload,
  codexHistoryCleanupThresholds,
  effectiveCodexHistoryCleanupMode,
  parseCodexHistoryCleanupPolicy,
  type CodexHistoryCleanupKind,
  type CodexHistoryCleanupMode,
  type CodexHistoryCleanupPolicy,
  type CodexHistoryCleanupThresholds
} from './codex-history-cleanup-policy'

const CODEX_HISTORY_CLEANUP_POLICY: ReleaseAssetPolicySpec<CodexHistoryCleanupPolicy> = {
  name: 'codex-history-cleanup-policy',
  releaseTag: (channel) => `codex-history-cleanup-policy-v1-${channel}`,
  assetName: 'codex-history-cleanup-policy.json',
  maxBytes: CODEX_HISTORY_CLEANUP_POLICY_MAX_BYTES,
  parse: parseCodexHistoryCleanupPolicy
}
// Homes checked one after another in a run share a download this recent, or a failure.
const SWEEP_REFRESH_REUSE_MS = 5 * 60_000
const SWEEP_REFRESH_FAILURE_BACKOFF_MS = 10 * 60_000

/** One sweep's modes and thresholds, decided at its start; `liveMode` is asked before each unlink. */
export type CodexHistoryCleanupSweepPolicy = {
  revision: number
  rollouts: { mode: CodexHistoryCleanupMode; thresholds: CodexHistoryCleanupThresholds<'rollouts'> }
  databases: {
    mode: CodexHistoryCleanupMode
    thresholds: CodexHistoryCleanupThresholds<'databases'>
  }
  liveMode: (kind: CodexHistoryCleanupKind) => CodexHistoryCleanupMode
}

let updater: ReleaseAssetPolicyLiveUpdater<CodexHistoryCleanupPolicy> | null = null
let readInstallId: () => string | undefined = () => undefined
let refreshing: Promise<void> | null = null
let refreshFailedAt: number | null = null
// The newest policy known as of the last sweep's start: only its `off` counts.
let newestKnown: CodexHistoryCleanupPolicy | null = null

function liveMode(kind: CodexHistoryCleanupKind): CodexHistoryCleanupMode {
  return effectiveCodexHistoryCleanupMode({
    kind,
    fetched: updater?.lastFetched() ?? null,
    newestKnown,
    now: Date.now(),
    platform: process.platform,
    installId: readInstallId()
  })
}

/** Cleanup runs only on macOS and Windows, so only they fetch; unpackaged runs never do. */
export function startCodexHistoryCleanupPolicyLiveUpdates(
  installId: () => string | undefined
): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return
  }
  const environment = getAppEnvironment()
  readInstallId = installId
  updater = new ReleaseAssetPolicyLiveUpdater(CODEX_HISTORY_CLEANUP_POLICY, {
    userDataPath: environment.getPath('userData'),
    appVersion: environment.getVersion(),
    isPackaged: environment.isPackaged(),
    fetch: (url, init) => getMainHttpClient().fetch(url, init)
  })
  const started = updater
  void started.start()
  environment.onWillQuit(() => started.stop())
}

/** Downloads the policy (at most once per few minutes) and decides this sweep's modes from it. */
export async function codexHistoryCleanupSweepPolicy(): Promise<CodexHistoryCleanupSweepPolicy> {
  const fetchedAt = updater?.lastFetched()?.at
  const now = Date.now()
  if (
    updater &&
    (fetchedAt === undefined || now - fetchedAt > SWEEP_REFRESH_REUSE_MS) &&
    (refreshFailedAt === null || now - refreshFailedAt > SWEEP_REFRESH_FAILURE_BACKOFF_MS)
  ) {
    refreshing ??= updater.refresh().finally(() => {
      refreshing = null
    })
    await refreshing.catch(() => {})
    refreshFailedAt = updater.lastFetched() ? null : Date.now()
  }
  newestKnown = (await updater?.newestKnown()) ?? null
  const fetched = updater?.lastFetched() ?? null
  const policy = authoritativeDownload(fetched) ?? newestKnown
  const thresholds = codexHistoryCleanupThresholds(policy)
  return {
    revision: policy?.revision ?? 0,
    rollouts: { mode: liveMode('rollouts'), thresholds: thresholds.rollouts },
    databases: { mode: liveMode('databases'), thresholds: thresholds.databases },
    liveMode
  }
}
