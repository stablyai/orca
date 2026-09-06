import { statSync } from 'node:fs'
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
  options: { clearIndex?: boolean } = {}
): Promise<AiVaultSearchCoverage | null> {
  const databasePath = getSessionSearchDatabasePath()
  if (!databasePath) {
    return Promise.resolve(null)
  }
  const policy: AiVaultSearchSettings = resolveAiVaultSearchSettings(settings)
  // Why: each call resolves scan roots before it reaches the scanner, so two
  // overlapping toggles could land out of order; apply them one after another.
  const applied = applyChain
    .catch(() => undefined)
    .then(() =>
      configureAiVaultSearch({ databasePath, ...policy }, { clearIndex: options.clearIndex })
    )
  applyChain = applied
  return applied
}

let applyChain: Promise<unknown> = Promise.resolve()

export function readAiVaultSearchIndexStatus(): AiVaultSearchIndexStatus {
  return { ...getSessionSearchPolicy(), indexSizeBytes: readAiVaultSearchIndexSizeBytes() }
}

/**
 * Reconciles a settings write. A no-op change is not forwarded, so re-saving the
 * same value never restarts a backfill that is already running.
 */
export function applyAiVaultSearchSettingsChange(
  before: Pick<GlobalSettings, 'aiVaultSearch'>,
  after: Pick<GlobalSettings, 'aiVaultSearch'>
): void {
  const previous = resolveAiVaultSearchSettings(before)
  const next = resolveAiVaultSearchSettings(after)
  if (previous.enabled === next.enabled && previous.historyDays === next.historyDays) {
    return
  }
  // A running scanner holds its consent state in memory; tell it now so the
  // change does not wait for an app restart.
  void applyAiVaultSearchSettings(after).catch((error: unknown) => {
    console.warn('[settings] failed to apply agent session search settings:', error)
  })
}

/** Deletes the database and its sidecars, then rebuilds if consent still stands. */
export function clearAiVaultSearchIndex(): Promise<AiVaultSearchCoverage | null> {
  return applyAiVaultSearchSettings(
    { aiVaultSearch: getSessionSearchPolicy() },
    { clearIndex: true }
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
