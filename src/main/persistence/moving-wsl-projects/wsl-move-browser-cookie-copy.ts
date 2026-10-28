/**
 * The `browser-cookies` rewrite store (owner decision 3): a committed WSL move copies the
 * desktop's in-app browser cookies once into the WSL host's route partition, or records why the
 * host starts on a fresh partition instead. Browser profiles are global, not per project, so each
 * profile's whole jar is copied, once per host partition, by the first move into that host.
 */
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import {
  emptyWslMoveBrowserCookieCopyCounts,
  WSL_MOVE_BROWSER_COOKIE_COPY_MAX_PROFILES,
  WSL_MOVE_BROWSER_COOKIES_STORE_ID,
  type WslMoveBrowserCookieCopy,
  type WslMoveBrowserCookieCopyCounts,
  type WslMoveBrowserCookieFreshPartitionReason
} from '../../../shared/wsl-move/wsl-move-browser-cookie-copy'
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import type {
  WslHostBrowserRouteStorage,
  WslHostBrowserRouteStorageResult
} from '../../browser/wsl-host-browser-route-partition'
import { listWslMoveCutovers, writeWslMoveCutover } from './wsl-move-cutover-journal'
import type { WslMoveDesktopRewriteContext } from './wsl-move-desktop-rewrite-stores'

export type WslMoveBrowserCookieCopyDependencies = {
  userDataPath: string
  /**
   * False until a partition may be opened (after the pending cookie import replay) and an app
   * window exists, so destroying the copy's hidden windows never closes the last one.
   */
  sessionsReady: () => boolean
  orcaProfileId: () => string | null
  listEnvironments: () => readonly KnownRuntimeEnvironment[]
  listBrowserProfiles: () => readonly { id: string; partition: string }[]
  resolveHostStorage: (
    orcaProfileId: string,
    environment: KnownRuntimeEnvironment
  ) => WslHostBrowserRouteStorageResult
  bindHostPartition: (storage: WslHostBrowserRouteStorage, browserProfileId: string) => string
  copyCookies: (
    sourcePartition: string,
    destinationPartition: string
  ) => Promise<WslMoveBrowserCookieCopyCounts>
  flushCookies: (partition: string) => Promise<void>
}

export type WslMoveBrowserCookieCopyPreview =
  | { kind: 'copy' }
  | { kind: 'fresh-partition'; reason: WslMoveBrowserCookieFreshPartitionReason }

/** What a move into `environment` would do with the logins; the move preview shows the reason. */
export function previewWslMoveBrowserCookieCopy(
  dependencies: Pick<WslMoveBrowserCookieCopyDependencies, 'resolveHostStorage'>,
  orcaProfileId: string,
  environment: KnownRuntimeEnvironment | undefined
): WslMoveBrowserCookieCopyPreview {
  if (!environment) {
    return { kind: 'fresh-partition', reason: 'destination-environment-missing' }
  }
  const storage = dependencies.resolveHostStorage(orcaProfileId, environment)
  return storage.kind === 'stable'
    ? { kind: 'copy' }
    : { kind: 'fresh-partition', reason: storage.reason }
}

/**
 * The store's `run`. Idempotent: a crash after the copy but before the ledger entry re-runs it,
 * and the merge then finds every cookie already present. The source partition is only read.
 * Returns the partitions written, which the store's `flush` makes durable.
 */
export async function runWslMoveBrowserCookieCopy(
  dependencies: WslMoveBrowserCookieCopyDependencies,
  context: Pick<WslMoveDesktopRewriteContext, 'cutover'>
): Promise<string[]> {
  if (!dependencies.sessionsReady()) {
    // No ledger entry: the pass after the first window shows retries it.
    throw new Error('wsl_move_browser_sessions_not_ready')
  }
  const orcaProfileId = dependencies.orcaProfileId()
  if (!orcaProfileId) {
    throw new Error('wsl_move_browser_sessions_not_ready')
  }
  const { cutover } = context
  const environment = dependencies
    .listEnvironments()
    .find((entry) => entry.id === cutover.destinationEnvironmentId)
  if (!environment) {
    recordOutcome(dependencies.userDataPath, cutover.migrationId, {
      outcome: 'fresh-partition',
      reason: 'destination-environment-missing'
    })
    return []
  }
  const storage = dependencies.resolveHostStorage(orcaProfileId, environment)
  if (storage.kind !== 'stable') {
    recordOutcome(dependencies.userDataPath, cutover.migrationId, {
      outcome: 'fresh-partition',
      reason: storage.reason
    })
    return []
  }
  const profiles = dependencies.listBrowserProfiles()
  let destinations: string[]
  try {
    // Every binding before any copy, so a conflict copies nothing; bindings match what a page makes.
    destinations = profiles.map((profile) =>
      dependencies.bindHostPartition(storage.storage, profile.id)
    )
  } catch (error) {
    if (error instanceof Error && error.message === 'browser_route_partition_binding_conflict') {
      recordOutcome(dependencies.userDataPath, cutover.migrationId, {
        outcome: 'fresh-partition',
        reason: 'destination-partition-conflict'
      })
      return []
    }
    throw error
  }
  const alreadyCopied = partitionsCopiedByEarlierMoves(dependencies.userDataPath, cutover)
  const written: string[] = []
  const results: Extract<WslMoveBrowserCookieCopy, { outcome: 'copied' }>['profiles'] = []
  for (const [index, profile] of profiles.entries()) {
    const destinationPartition = destinations[index]
    if (!destinationPartition) {
      continue
    }
    // Why once per partition: a second copy would revive logins the user signed out of there.
    if (alreadyCopied.has(destinationPartition)) {
      results.push({
        browserProfileId: profile.id,
        destinationPartition,
        alreadyCopied: true,
        counts: emptyWslMoveBrowserCookieCopyCounts()
      })
      continue
    }
    const counts = await dependencies.copyCookies(profile.partition, destinationPartition)
    written.push(destinationPartition)
    results.push({
      browserProfileId: profile.id,
      destinationPartition,
      alreadyCopied: false,
      counts
    })
  }
  recordOutcome(dependencies.userDataPath, cutover.migrationId, {
    outcome: 'copied',
    // Within the journal's bound, so a huge profile list never blocks the ledger entry.
    profiles: results.slice(0, WSL_MOVE_BROWSER_COOKIE_COPY_MAX_PROFILES)
  })
  return written
}

/** Partitions another move durably copied into: its ledger already holds this store. */
function partitionsCopiedByEarlierMoves(
  userDataPath: string,
  cutover: Readonly<WslMoveCutover>
): Set<string> {
  const partitions = new Set<string>()
  for (const entry of listWslMoveCutovers(userDataPath)) {
    const record = entry.browserCookieCopy
    if (
      entry.migrationId === cutover.migrationId ||
      entry.destinationEnvironmentId !== cutover.destinationEnvironmentId ||
      !entry.rewrittenStores.includes(WSL_MOVE_BROWSER_COOKIES_STORE_ID) ||
      record?.outcome !== 'copied'
    ) {
      continue
    }
    for (const profile of record.profiles) {
      partitions.add(profile.destinationPartition)
    }
  }
  return partitions
}

/** Written before the ledger entry, from a fresh read, so the driver's append keeps it. */
function recordOutcome(
  userDataPath: string,
  migrationId: string,
  browserCookieCopy: WslMoveBrowserCookieCopy
): void {
  const current = listWslMoveCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (current?.phase !== 'destination-committed') {
    throw new Error('wsl_move_record_missing')
  }
  writeWslMoveCutover(userDataPath, {
    ...current,
    browserCookieCopy,
    updatedAt: new Date().toISOString()
  })
}
