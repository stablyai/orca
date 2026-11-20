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
// Set once downloads may start (after the proxy settings apply); cleared when the cleanup is over.
let createUpdater: (() => ReleaseAssetPolicyLiveUpdater<JournalRetirementPolicy>) | null = null
// The newest policy seen this run: only its `off` counts, so a later failed read can't undo it.
let newestKnown: JournalRetirementPolicy | null = null

/**
 * Allows downloads; none starts until the cleanup first asks, so a profile without an old journal
 * never downloads this policy. Unpackaged runs never fetch, so they stay in report mode.
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
  environment.onWillQuit(stopJournalRetirementPolicyUpdates)
}

/** The cleanup is over for this launch: downloads stop and never start again. */
export function stopJournalRetirementPolicyUpdates(): void {
  createUpdater = null
  updater?.stop()
  updater = null
}

function startOnFirstAsk(): void {
  if (updater || !createUpdater) {
    return
  }
  const started = createUpdater()
  updater = started
  starting = started.start().finally(() => {
    starting = null
    refreshFailedAt = started.lastFetched() ? null : Date.now()
  })
  void starting.catch(() => {})
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
  startOnFirstAsk()
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
      refreshing = null
      refreshFailedAt = running.lastFetched() ? null : Date.now()
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
    release: stopJournalRetirementPolicyUpdates
  })
}
