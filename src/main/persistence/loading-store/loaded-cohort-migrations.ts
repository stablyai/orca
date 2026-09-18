import { randomUUID } from 'node:crypto'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceTrustEntry } from '../../../shared/workspace-trust-types'

import type { StoreRuntimeState } from './store-runtime-state'

type LoadedCohortMigrationOperationsRuntime = Pick<StoreRuntimeState, 'loadNeedsSave'>

export class LoadedCohortMigrationOperations {
  constructor(private readonly runtime: LoadedCohortMigrationOperationsRuntime) {}

  migrateTabSwitchKeybindings(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existing = state.settings?.tabSwitchKeybindingSeed
    if (existing === 'pending' || existing === 'done') {
      return state
    }
    // Why: mark dirty so the frozen cohort persists; else a fresh install re-reads as "existing" after its file lands.
    this.runtime.loadNeedsSave = true
    return {
      ...state,
      settings: {
        ...state.settings,
        // Existing installs pin old chords via a keybindings.json seed; fresh installs use the new registry defaults.
        tabSwitchKeybindingSeed: fileExistedOnLoad ? 'pending' : 'done'
      }
    }
  }

  migrateTelemetry(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existing = state.settings?.telemetry
    // Why: require all three invariants; keying on existedBeforeTelemetryRelease alone lets a partial block skip migration.
    if (
      typeof existing?.existedBeforeTelemetryRelease === 'boolean' &&
      typeof existing.installId === 'string' &&
      existing.installId.length > 0 &&
      (existing.optedIn === true || existing.optedIn === false || existing.optedIn === null)
    ) {
      return state
    }
    // Why: resolve cohort once; re-inferring it in the optedIn fallback could misclassify a partially-written new user.
    const resolvedExistedBefore =
      typeof existing?.existedBeforeTelemetryRelease === 'boolean'
        ? existing.existedBeforeTelemetryRelease
        : fileExistedOnLoad
    return {
      ...state,
      settings: {
        ...state.settings,
        telemetry: {
          ...existing,
          existedBeforeTelemetryRelease: resolvedExistedBefore,
          // Why: preserve any explicit opt-in/out; fall back to cohort default only when optedIn is undefined, never when false.
          optedIn:
            existing?.optedIn === true || existing?.optedIn === false || existing?.optedIn === null
              ? existing.optedIn
              : resolvedExistedBefore
                ? null
                : true,
          installId:
            typeof existing?.installId === 'string' && existing.installId.length > 0
              ? existing.installId
              : randomUUID()
        }
      }
    }
  }

  /**
   * One-shot: every local (connectionId == null) Repo/FolderWorkspace present at migration
   * time is grandfathered trusted, so nobody loses capability nor gets a prompt avalanche.
   * Entries added after this fires go through the normal intake trust flow instead.
   */
  migrateWorkspaceTrust(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    if (state.settings?.workspaceTrustMigratedExistingWorkspaces === true) {
      return state
    }
    this.runtime.loadNeedsSave = true
    const existingEntries = state.settings?.workspaceTrustEntries ?? []
    const grandfathered: WorkspaceTrustEntry[] = []
    if (fileExistedOnLoad) {
      const grandfatheredPaths = new Set(existingEntries.map((entry) => entry.path))
      const decidedAt = Date.now()
      for (const repo of state.repos ?? []) {
        if (repo.connectionId != null || grandfatheredPaths.has(repo.path)) {
          continue
        }
        grandfatheredPaths.add(repo.path)
        grandfathered.push({
          id: randomUUID(),
          path: repo.path,
          trusted: true,
          decidedAt,
          origin: 'migration'
        })
      }
      for (const folderWorkspace of state.folderWorkspaces ?? []) {
        if (
          folderWorkspace.connectionId != null ||
          grandfatheredPaths.has(folderWorkspace.folderPath)
        ) {
          continue
        }
        grandfatheredPaths.add(folderWorkspace.folderPath)
        grandfathered.push({
          id: randomUUID(),
          path: folderWorkspace.folderPath,
          trusted: true,
          decidedAt,
          origin: 'migration'
        })
      }
    }
    return {
      ...state,
      settings: {
        ...state.settings,
        workspaceTrustEntries: [...existingEntries, ...grandfathered],
        workspaceTrustMigratedExistingWorkspaces: true
      }
    }
  }
}
