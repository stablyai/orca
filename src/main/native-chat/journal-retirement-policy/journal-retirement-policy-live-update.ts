import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { getMainHttpClient } from '../../network/http-client'
import type { Store } from '../../persistence/loading-store/store'
import { readInstallId as readStoredInstallId } from '../../telemetry/install-id'
import { track } from '../../telemetry/client'
import { legacyJournalRetirementSchema } from '../../../shared/telemetry/schemas/telemetry-legacy-journal-retirement-schema'
import { setLegacyJournalRetirementHost } from '../agent-session-journal/journal-legacy-retirement-outcome'
import {
  ReleaseAssetPolicyLiveUpdater,
  readCachedReleaseAssetPolicyAsync,
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
const REFRESH_FAILURE_BACKOFF_MS = 10 * 60_000

let updater: ReleaseAssetPolicyLiveUpdater<JournalRetirementPolicy> | null = null
let readInstallId: () => string | undefined = () => undefined
let refreshing: Promise<void> | null = null
let refreshFailedAt: number | null = null
let starting: Promise<void> | null = null
// Set once downloads may start (after the proxy settings apply); cleared on quit.
let createUpdater: (() => ReleaseAssetPolicyLiveUpdater<JournalRetirementPolicy>) | null = null
// A cleanup asked this run (so at least one download is owed), and one still needs the policy.
let asked = false
let needed = false
// The newest policy seen this run: only its `off` counts, so a later failed read can't undo it.
let newestKnown: JournalRetirementPolicy | null = null

/**
 * Allows downloads. None starts until a cleanup asks, so a profile without an old journal never
 * downloads this policy; an ask made before this still gets its download, so a newer revision can
 * always replace a cached `off`. Unpackaged runs never fetch, so they stay in report mode.
 */
export function allowJournalRetirementPolicyUpdates(store: Store): void {
  const environment = getAppEnvironment()
  readInstallId = () => readStoredInstallId(store)
  createUpdater = () =>
    new ReleaseAssetPolicyLiveUpdater(JOURNAL_RETIREMENT_POLICY, {
      userDataPath: environment.getPath('userData'),
      appVersion: environment.getVersion(),
      isPackaged: environment.isPackaged(),
      fetch: (url, init) => getMainHttpClient().fetch(url, init)
    })
  environment.onWillQuit(() => {
    createUpdater = null
    updater?.stop()
    updater = null
  })
  if (asked) {
    startDownloads()
    stopWhenUnneeded()
  }
}

/** The cleanup needs the policy no longer; a cleanup that asks again starts downloads again. */
export function releaseJournalRetirementPolicyUpdates(): void {
  needed = false
  stopWhenUnneeded()
}

function startDownloads(): void {
  if (updater || !createUpdater) {
    return
  }
  const started = createUpdater()
  updater = started
  starting = started.start().finally(() => {
    if (updater === started) {
      starting = null
      refreshFailedAt = started.lastFetched() ? null : Date.now()
    }
  })
  void starting.catch(() => {})
}

/** Stops once the download in flight has written the cache, unless a cleanup asked again. */
function stopWhenUnneeded(): void {
  const running = updater
  if (!running || needed) {
    return
  }
  const inFlight = [starting, refreshing].filter((pending) => pending !== null)
  void Promise.allSettled(inFlight).then(() => {
    if (!needed && updater === running) {
      running.stop()
      updater = null
      starting = null
      refreshing = null
    }
  })
}

/**
 * Decides from what is known now and never waits on the network: the cleanup runs during startup
 * maintenance. The first ask starts the downloads; until one arrives, the cached policy alone
 * decides, so a cached `off` holds from the first ask.
 */
export async function journalRetirementMode(): Promise<{
  mode: JournalRetirementMode
  revision: number
}> {
  asked = true
  needed = true
  startDownloads()
  const fetchedAt = updater?.lastFetched()?.at
  const now = Date.now()
  if (
    updater &&
    !starting &&
    fetchedAt === undefined &&
    (refreshFailedAt === null || now - refreshFailedAt > REFRESH_FAILURE_BACKOFF_MS)
  ) {
    const running = updater
    refreshing ??= running.refresh().finally(() => {
      if (updater === running) {
        refreshing = null
        refreshFailedAt = running.lastFetched() ? null : Date.now()
      }
    })
    void refreshing.catch(() => {})
  }
  const read = updater ? await updater.newestKnown() : await readCachedPolicy()
  newestKnown = newestJournalRetirementPolicy(read ? { policy: read } : null, newestKnown)
  return effectiveJournalRetirementMode({
    fetched: updater?.lastFetched() ?? null,
    newestKnown,
    now: Date.now(),
    platform: process.platform,
    installId: readInstallId()
  })
}

async function readCachedPolicy(): Promise<JournalRetirementPolicy | null> {
  try {
    const environment = getAppEnvironment()
    return await readCachedReleaseAssetPolicyAsync(
      JOURNAL_RETIREMENT_POLICY,
      environment.getPath('userData'),
      environment.getVersion()
    )
  } catch {
    return null
  }
}

/**
 * The desktop runs the cleanup in this process's runtime: it asks this policy before deleting and
 * reports where it stopped through the usage-event client, which validates every field. Installed
 * before the runtime starts, so the first ask already honors a cached `off`.
 */
export function installJournalRetirementHost(store: Store): void {
  readInstallId = () => readStoredInstallId(store)
  setLegacyJournalRetirementHost({
    report: async (event) =>
      track('legacy_journal_retirement', legacyJournalRetirementSchema.parse(event)),
    mode: journalRetirementMode,
    release: releaseJournalRetirementPolicyUpdates
  })
}
