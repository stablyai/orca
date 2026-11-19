import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { getMainHttpClient } from '../../../network/http-client'
import type { Store } from '../../../persistence/loading-store/store'
import { readInstallId as readStoredInstallId } from '../../../telemetry/install-id'
import {
  ReleaseAssetPolicyLiveUpdater,
  type ReleaseAssetPolicySpec
} from '../../../remote-policies/release-asset-policy-live-update'
import {
  CODEX_HISTORY_CLEANUP_POLICY_MAX_BYTES,
  authoritativeDownload,
  newestCodexHistoryCleanupPolicy,
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
// The launch download, which a sweep waits for rather than downloading again beside it.
let starting: Promise<void> | null = null
// The newest policy any sweep this run has seen: only its `off` counts.
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
export function startCodexHistoryCleanupPolicyLiveUpdates(store: Store): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return
  }
  const environment = getAppEnvironment()
  readInstallId = () => readStoredInstallId(store)
  updater = new ReleaseAssetPolicyLiveUpdater(CODEX_HISTORY_CLEANUP_POLICY, {
    userDataPath: environment.getPath('userData'),
    appVersion: environment.getVersion(),
    isPackaged: environment.isPackaged(),
    fetch: (url, init) => getMainHttpClient().fetch(url, init)
  })
  const started = updater
  starting = started.start()
  void starting.catch(() => {})
  environment.onWillQuit(() => started.stop())
}

/** Downloads the policy (at most once per few minutes) and decides this sweep's modes from it. */
export async function codexHistoryCleanupSweepPolicy(): Promise<CodexHistoryCleanupSweepPolicy> {
  if (starting) {
    await starting.catch(() => {})
    starting = null
    refreshFailedAt = updater?.lastFetched() ? null : Date.now()
  }
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
  const read = (await updater?.newestKnown()) ?? null
  // Kept across sweeps, so a cache read that fails later can't bring back an older revision.
  newestKnown = newestCodexHistoryCleanupPolicy(read ? { policy: read } : null, newestKnown)
  const fetched = updater?.lastFetched() ?? null
  const known = newestCodexHistoryCleanupPolicy(fetched, newestKnown)
  const policy = authoritativeDownload(fetched, known) ?? known
  const thresholds = codexHistoryCleanupThresholds(policy)
  return {
    revision: policy?.revision ?? 0,
    rollouts: { mode: liveMode('rollouts'), thresholds: thresholds.rollouts },
    databases: { mode: liveMode('databases'), thresholds: thresholds.databases },
    liveMode
  }
}
