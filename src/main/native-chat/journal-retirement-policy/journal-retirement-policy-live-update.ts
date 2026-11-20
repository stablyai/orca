import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { getMainHttpClient } from '../../network/http-client'
import type { Store } from '../../persistence/loading-store/store'
import { readInstallId as readStoredInstallId } from '../../telemetry/install-id'
import {
  ReleaseAssetPolicyLiveUpdater,
  type ReleaseAssetPolicySpec
} from '../../remote-policies/release-asset-policy-live-update'
import {
  JOURNAL_RETIREMENT_POLICY_MAX_BYTES,
  effectiveJournalRetirementMode,
  newestJournalRetirementPolicy,
  parseJournalRetirementPolicy,
  type JournalRetirementMode,
  type JournalRetirementPolicy
} from './journal-retirement-policy'

const JOURNAL_RETIREMENT_POLICY: ReleaseAssetPolicySpec<JournalRetirementPolicy> = {
  name: 'journal-retirement-policy',
  releaseTag: (channel) => `journal-retirement-policy-v1-${channel}`,
  assetName: 'journal-retirement-policy.json',
  maxBytes: JOURNAL_RETIREMENT_POLICY_MAX_BYTES,
  parse: parseJournalRetirementPolicy
}
// Asked before each destructive step: a download this recent, or a failure, is reused.
const REFRESH_REUSE_MS = 5 * 60_000
const REFRESH_FAILURE_BACKOFF_MS = 10 * 60_000

let updater: ReleaseAssetPolicyLiveUpdater<JournalRetirementPolicy> | null = null
let readInstallId: () => string | undefined = () => undefined
let refreshing: Promise<void> | null = null
let refreshFailedAt: number | null = null
let starting: Promise<void> | null = null
// The newest policy seen this run: only its `off` counts, so a later failed read can't undo it.
let newestKnown: JournalRetirementPolicy | null = null

/** Unpackaged runs never fetch, so they stay in report mode. */
export function startJournalRetirementPolicyLiveUpdates(store: Store): void {
  const environment = getAppEnvironment()
  readInstallId = () => readStoredInstallId(store)
  updater = new ReleaseAssetPolicyLiveUpdater(JOURNAL_RETIREMENT_POLICY, {
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

/** Refreshes at most once per few minutes, reading the cache asynchronously, then decides. */
export async function journalRetirementMode(): Promise<{
  mode: JournalRetirementMode
  revision: number
}> {
  if (starting) {
    await starting.catch(() => {})
    starting = null
    refreshFailedAt = updater?.lastFetched() ? null : Date.now()
  }
  const fetchedAt = updater?.lastFetched()?.at
  const now = Date.now()
  if (
    updater &&
    (fetchedAt === undefined || now - fetchedAt > REFRESH_REUSE_MS) &&
    (refreshFailedAt === null || now - refreshFailedAt > REFRESH_FAILURE_BACKOFF_MS)
  ) {
    refreshing ??= updater.refresh().finally(() => {
      refreshing = null
    })
    await refreshing.catch(() => {})
    refreshFailedAt = updater.lastFetched() ? null : Date.now()
  }
  const read = (await updater?.newestKnown()) ?? null
  newestKnown = newestJournalRetirementPolicy(read ? { policy: read } : null, newestKnown)
  return effectiveJournalRetirementMode({
    fetched: updater?.lastFetched() ?? null,
    newestKnown,
    now: Date.now(),
    platform: process.platform,
    installId: readInstallId()
  })
}
