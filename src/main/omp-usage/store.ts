import { app } from 'electron'
import { join } from 'node:path'
import type { Store } from '../persistence'
import { UsageProviderStoreLifecycle } from '../usage/usage-provider-store-lifecycle'
import { splitUsageCacheFileViaWorker } from '../usage/usage-scan-worker-spawn'
import { scanOmpUsageFiles } from './scanner'
import type { OmpUsagePersistedState } from './types'

export const OMP_USAGE_SCHEMA_VERSION = 1

let ompUsageFile: string | null = null

export function initOmpUsagePath(): void {
  ompUsageFile = join(app.getPath('userData'), 'orca-omp-usage.json')
}

function getOmpUsageFile(): string {
  ompUsageFile ??= join(app.getPath('userData'), 'orca-omp-usage.json')
  return ompUsageFile
}

export function getDefaultOmpUsageState(): OmpUsagePersistedState {
  return {
    schemaVersion: OMP_USAGE_SCHEMA_VERSION,
    worktreeFingerprint: null,
    processedFiles: [],
    sessions: [],
    dailyAggregates: [],
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    }
  }
}

export function normalizePersistedState(state: OmpUsagePersistedState): OmpUsagePersistedState {
  if (state.schemaVersion !== OMP_USAGE_SCHEMA_VERSION) {
    // Rebuild incompatible projections while preserving the user's tracking preference.
    const defaults = getDefaultOmpUsageState()
    return {
      ...defaults,
      scanState: {
        ...defaults.scanState,
        enabled: state.scanState?.enabled ?? defaults.scanState.enabled
      }
    }
  }
  return state
}

export class OmpUsageStore extends UsageProviderStoreLifecycle<
  'processedFiles',
  OmpUsagePersistedState,
  'hasAnyOmpData'
> {
  readonly id = 'omp' as const
  readonly label = 'omp' as const

  constructor(store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>) {
    super(store, {
      logTag: '[omp-usage]',
      resolveCacheFile: getOmpUsageFile,
      createDefaultState: getDefaultOmpUsageState,
      normalizeState: normalizePersistedState,
      sourceKey: 'processedFiles',
      dataPresenceKey: 'hasAnyOmpData',
      scan: scanOmpUsageFiles,
      splitCacheFile: splitUsageCacheFileViaWorker
    })
  }
}
