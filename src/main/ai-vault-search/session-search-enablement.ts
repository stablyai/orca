import { existsSync, statSync } from 'node:fs'
import { getAiVaultServiceEntryPath } from '../ai-vault/session-scanner-service-entry-path'
import { sessionSearchCapability } from './session-search-capability'
import type { AiVaultSearchCoverage } from '../../shared/ai-vault-search-types'
import {
  resolveAiVaultSearchSettings,
  type AiVaultSearchIndexStatus,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { configureAiVaultSearch } from '../ai-vault/cached-session-list'
import { getSessionSearchDatabasePath } from './session-search-paths'
import { configureSessionSearchPolicySource, getSessionSearchPolicy } from './session-search-policy'

type SettingsSource = () => Pick<GlobalSettings, 'aiVaultSearch'>

let notifyIndexingChanged: () => void = () => {}

/**
 * Installs the push the renderer listens on. Every apply — enable, disable, history change,
 * pause, resume, clear — settles through `applyAiVaultSearchSettings`, so one notify there
 * replaces a standing coverage poll on every surface.
 */
export function setSessionSearchIndexingChangeNotifier(notify: (() => void) | null): void {
  notifyIndexingChanged = notify ?? (() => {})
}

/**
 * Single seam between the settings store and the index. Both the desktop IPC
 * layer and `orca serve` install it, so the scanner's consent state comes from
 * the same place no matter which composition root ran.
 */
export function installAiVaultSearchSettingsSource(source: SettingsSource | null): void {
  configureSessionSearchPolicySource(source)
}

/**
 * Applies the persisted policy to a scanner that is already running. Returns
 * null when nothing is running or the index path was never initialized — both
 * mean the next spawn will read the new policy from its init payload.
 */
export function applyAiVaultSearchSettings(
  settings: Pick<GlobalSettings, 'aiVaultSearch'>,
  options: { clearIndex?: boolean; persist?: () => void | Promise<void> } = {}
): Promise<AiVaultSearchCoverage | null> {
  const databasePath = getSessionSearchDatabasePath()
  if (!databasePath) {
    return Promise.reject(new Error('Session search paths are not initialized.'))
  }
  const policy: AiVaultSearchSettings = resolveAiVaultSearchSettings(settings)
  // Why: each call resolves scan roots before it reaches the scanner, so two
  // overlapping toggles could land out of order; apply them one after another.
  const generation = ++applyGeneration
  policyApplied = false
  const applied = applyChain
    .catch(() => undefined)
    .then(async () => {
      // Why persist first: a crash between the two leaves transcripts indexed under a
      // consent record that still reads `disabled`, and nothing but an explicit clear
      // ever deletes them. "Persisted but not applied" is already a modelled state.
      await options.persist?.()
      const result = await configureAiVaultSearch(
        { databasePath, ...policy },
        { clearIndex: options.clearIndex }
      )
      if (generation === applyGeneration) {
        policyApplied = true
      }
      return result
    })
  applyChain = applied
  // Why: the reading every surface holds was taken before this apply and is now stale whether the
  // apply succeeded or not, so both outcomes have to invite a re-read.
  void applied.then(
    () => notifyIndexingChanged(),
    () => notifyIndexingChanged()
  )
  return applied
}

let applyChain: Promise<unknown> = Promise.resolve()
let policyApplied = true
let applyGeneration = 0

/**
 * Reconciles a settings write. An unchanged policy is not forwarded, so re-saving
 * the same value never restarts a running backfill, and a scanner that cannot
 * apply must not fail or delay the settings save — `readAiVaultSearchIndexStatus`
 * reports that through `applied` and `reason`.
 */
export function applyAiVaultSearchSettingsChange(
  before: Pick<GlobalSettings, 'aiVaultSearch'>,
  after: Pick<GlobalSettings, 'aiVaultSearch'>,
  persist: () => void | Promise<void>
): void {
  const previous = resolveAiVaultSearchSettings(before)
  const next = resolveAiVaultSearchSettings(after)
  if (
    previous.enabled === next.enabled &&
    previous.historyDays === next.historyDays &&
    (previous.paused ?? false) === (next.paused ?? false)
  ) {
    return
  }
  void applyAiVaultSearchSettings(after, { persist }).catch((error: unknown) => {
    console.warn('[settings] failed to apply agent session search settings:', error)
  })
}

export function readAiVaultSearchIndexStatus(): AiVaultSearchIndexStatus {
  const capability = sessionSearchCapability()
  const available =
    capability.available &&
    !!getSessionSearchDatabasePath() &&
    existsSync(getAiVaultServiceEntryPath())
  return {
    ...getSessionSearchPolicy(),
    indexSizeBytes: readAiVaultSearchIndexSizeBytes(),
    available,
    applied: available && policyApplied,
    ...(!available
      ? { reason: capability.reason ?? 'Session search service is not installed or initialized.' }
      : !policyApplied
        ? { reason: 'Index policy application or persistence failed or is pending.' }
        : {})
  }
}

/** Deletes the database and its sidecars, then rebuilds if consent still stands. */
export function clearAiVaultSearchIndex(
  persist: () => void | Promise<void>
): Promise<AiVaultSearchCoverage | null> {
  return applyAiVaultSearchSettings(
    { aiVaultSearch: getSessionSearchPolicy() },
    { clearIndex: true, persist }
  )
}

/** Bytes the index occupies including its WAL sidecars; null when it does not exist. */
export function readAiVaultSearchIndexSizeBytes(): number | null {
  const databasePath = getSessionSearchDatabasePath()
  if (!databasePath) {
    return null
  }
  let total: number
  try {
    total = statSync(databasePath).size
  } catch {
    // Why: a leftover sidecar without the main file is not an index.
    return null
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      total += statSync(`${databasePath}${suffix}`).size
    } catch {
      // A missing sidecar is normal.
    }
  }
  return total
}
