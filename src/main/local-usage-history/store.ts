import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { dirname, join } from 'node:path'
import type {
  LocalUsageHistoryHourlyPoint,
  LocalUsageHistoryHourlyQuery,
  LocalUsageHistoryHourlyResult,
  LocalUsageHistoryProvider,
  LocalUsageHistoryScanState
} from '../../shared/local-usage-history-types'
import { getLocalUsageHistorySource, scanLocalUsageHistory } from './scanner'
import type { LocalUsageHistoryPersistedState, LocalUsageHistoryStoreOptions } from './types'

const SCHEMA_VERSION = 1
const STALE_MS = 5 * 60_000

let usageDataDirectory: string | null = null

export function initLocalUsageHistoryPaths(): void {
  usageDataDirectory = app.getPath('userData')
}

function getDefaultState(): LocalUsageHistoryPersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    processedFiles: [],
    hourlyAggregates: [],
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    }
  }
}

function isValidDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  return (
    parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
  )
}

function getDayCutoff(days: number): string {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - (days - 1))
  return formatLocalDay(date)
}

function formatLocalDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`
}

export class LocalUsageHistoryStore {
  private state: LocalUsageHistoryPersistedState
  private scanPromise: Promise<void> | null = null

  constructor(
    private readonly provider: LocalUsageHistoryProvider,
    private readonly options: LocalUsageHistoryStoreOptions = {}
  ) {
    this.state = this.load()
  }

  private getUsageFilePath(): string {
    if (this.options.usageFilePath) {
      return this.options.usageFilePath
    }
    return join(usageDataDirectory ?? app.getPath('userData'), `orca-${this.provider}-usage.json`)
  }

  private load(): LocalUsageHistoryPersistedState {
    try {
      const path = this.getUsageFilePath()
      if (!existsSync(path)) {
        return getDefaultState()
      }
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LocalUsageHistoryPersistedState
      if (parsed.schemaVersion !== SCHEMA_VERSION) {
        return {
          ...getDefaultState(),
          scanState: {
            ...getDefaultState().scanState,
            enabled: parsed.scanState?.enabled ?? false
          }
        }
      }
      return {
        ...getDefaultState(),
        ...parsed,
        processedFiles: parsed.processedFiles ?? [],
        hourlyAggregates: parsed.hourlyAggregates ?? [],
        scanState: { ...getDefaultState().scanState, ...parsed.scanState }
      }
    } catch (error) {
      console.error(`[${this.provider}-usage] Failed to load persisted state:`, error)
      return getDefaultState()
    }
  }

  private writeToDisk(): void {
    const path = this.getUsageFilePath()
    const directory = dirname(path)
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true })
    }
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2), 'utf-8')
    renameSync(temporaryPath, path)
  }

  getScanState(): LocalUsageHistoryScanState {
    return {
      ...this.state.scanState,
      isScanning: this.scanPromise !== null,
      hasAnyData: this.state.hourlyAggregates.length > 0
    }
  }

  async setEnabled(enabled: boolean): Promise<LocalUsageHistoryScanState> {
    this.state.scanState.enabled = enabled
    this.writeToDisk()
    return this.getScanState()
  }

  async refresh(force = false): Promise<LocalUsageHistoryScanState> {
    if (!this.state.scanState.enabled) {
      return this.getScanState()
    }
    const lastScan = this.state.scanState.lastScanCompletedAt
    if (!force && lastScan !== null && Date.now() - lastScan < STALE_MS) {
      return this.getScanState()
    }
    await this.runScan()
    return this.getScanState()
  }

  async getHourly(query: LocalUsageHistoryHourlyQuery): Promise<LocalUsageHistoryHourlyResult> {
    await this.refresh(false)
    return {
      scanState: this.getScanState(),
      points: this.getHourlyPoints(query)
    }
  }

  private getHourlyPoints(query: LocalUsageHistoryHourlyQuery): LocalUsageHistoryHourlyPoint[] {
    const range = getQueryRange(query)
    if (!range) {
      return []
    }
    return this.state.hourlyAggregates.filter(
      (point) => point.day >= range.startDay && point.day <= range.endDay
    )
  }

  private async runScan(): Promise<void> {
    if (this.scanPromise) {
      await this.scanPromise
      return
    }
    this.state.scanState.lastScanStartedAt = Date.now()
    this.state.scanState.lastScanError = null
    this.writeToDisk()

    this.scanPromise = (async () => {
      try {
        const source = getLocalUsageHistorySource(this.provider)
        const result = await scanLocalUsageHistory({
          provider: this.provider,
          rootDir: this.options.sourceRoot?.() ?? source.rootDir,
          previousFiles: this.state.processedFiles
        })
        this.state.processedFiles = result.processedFiles
        this.state.hourlyAggregates = result.hourlyAggregates
        this.state.scanState.lastScanCompletedAt = Date.now()
        this.state.scanState.lastScanError = null
      } catch (error) {
        this.state.scanState.lastScanError = error instanceof Error ? error.message : String(error)
      } finally {
        this.writeToDisk()
        this.scanPromise = null
      }
    })()
    await this.scanPromise
  }
}

function getQueryRange(query: LocalUsageHistoryHourlyQuery): {
  startDay: string
  endDay: string
} | null {
  if ('days' in query) {
    if (!Number.isInteger(query.days) || query.days < 1) {
      return null
    }
    return { startDay: getDayCutoff(query.days), endDay: formatLocalDay(new Date()) }
  }
  if (
    !isValidDayKey(query.startDay) ||
    !isValidDayKey(query.endDay) ||
    query.startDay > query.endDay
  ) {
    return null
  }
  return query
}
