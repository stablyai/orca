import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { readNodeFileWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
import { getMainHttpClient } from '../../../network/http-client'
import {
  ReleaseAssetPolicyLiveUpdater,
  releaseAssetPolicyCacheFileName,
  releaseAssetPolicyChannelForAppVersion,
  type ReleaseAssetPolicySpec
} from '../../../remote-policies/release-asset-policy-live-update'
import {
  CODEX_HISTORY_CLEANUP_POLICY_MAX_BYTES,
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
// Homes checked one after another in a run share a download this recent.
const SWEEP_REFRESH_REUSE_MS = 5 * 60_000

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
let cachePath: string | null = null
// The cached policy as of the last sweep's start: only its `off` counts.
let cached: CodexHistoryCleanupPolicy | null = null

function liveMode(kind: CodexHistoryCleanupKind): CodexHistoryCleanupMode {
  return effectiveCodexHistoryCleanupMode({
    kind,
    fetched: updater?.lastFetched() ?? null,
    cached,
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
  const channel = releaseAssetPolicyChannelForAppVersion(environment.getVersion())
  cachePath = channel
    ? join(
        environment.getPath('userData'),
        releaseAssetPolicyCacheFileName(CODEX_HISTORY_CLEANUP_POLICY, channel)
      )
    : null
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
  if (updater && (fetchedAt === undefined || Date.now() - fetchedAt > SWEEP_REFRESH_REUSE_MS)) {
    refreshing ??= updater.refresh().finally(() => {
      refreshing = null
    })
    await refreshing.catch(() => {})
  }
  cached = await readCachedPolicy()
  const policy = updater?.lastFetched()?.policy ?? cached
  return {
    revision: policy?.revision ?? 0,
    rollouts: {
      mode: liveMode('rollouts'),
      thresholds: codexHistoryCleanupThresholds(policy, 'rollouts')
    },
    databases: {
      mode: liveMode('databases'),
      thresholds: codexHistoryCleanupThresholds(policy, 'databases')
    },
    liveMode
  }
}

async function readCachedPolicy(): Promise<CodexHistoryCleanupPolicy | null> {
  if (!cachePath) {
    return null
  }
  try {
    const { buffer } = await readNodeFileWithinLimit(
      cachePath,
      CODEX_HISTORY_CLEANUP_POLICY_MAX_BYTES,
      { regularFileOnly: true }
    )
    const parsed = parseCodexHistoryCleanupPolicy(buffer.toString('utf8'))
    return parsed.ok ? parsed.policy : null
  } catch {
    return null
  }
}
