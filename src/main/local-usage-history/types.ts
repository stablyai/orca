import type {
  LocalUsageHistoryHourlyPoint,
  LocalUsageHistoryProvider
} from '../../shared/local-usage-history-types'

export type LocalUsageHistoryPersistedFile = {
  path: string
  mtimeMs: number
  size: number
  hourlyAggregates: LocalUsageHistoryHourlyPoint[]
}

export type LocalUsageHistoryPersistedState = {
  schemaVersion: number
  processedFiles: LocalUsageHistoryPersistedFile[]
  hourlyAggregates: LocalUsageHistoryHourlyPoint[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type LocalUsageHistoryScanResult = {
  processedFiles: LocalUsageHistoryPersistedFile[]
  hourlyAggregates: LocalUsageHistoryHourlyPoint[]
}

export type LocalUsageHistoryStoreOptions = {
  sourceRoot?: () => string
  usageFilePath?: string
}

export type LocalUsageHistorySource = {
  provider: LocalUsageHistoryProvider
  rootDir: string
}
