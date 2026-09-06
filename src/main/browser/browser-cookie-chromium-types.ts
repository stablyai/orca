import type { Session } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary
} from '../../shared/browser-workspace-types'
import type { DetectedBrowser } from './browser-cookie-detection-types'
import type { CookieImportOptions } from './browser-cookie-import-pipeline'
import type {
  ImportedCookieFields,
  ImportWritePhase,
  SourceCookieToWrite
} from './browser-cookie-import-write'
import type { SourcePartitionRead } from './browser-cookie-source-partition'
import type { ImportedDomainScope } from './browser-cookie-import-policy'
import type { ChromiumCookieSnapshot } from './chromium-cookie-snapshot'
import type { ChromiumCookieColumnInfo, EncryptionKeyResult } from './browser-cookie-sqlite'

export type ChromiumSourceRow = Record<string, unknown>

export type DecryptedCookie = Omit<ImportedCookieFields, 'url'> & {
  decryptedValue: Buffer
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  partition: SourcePartitionRead
}

export type ScannedChromiumCookie = {
  entry: DecryptedCookie
  sourceRow: ChromiumSourceRow
}

export type ChromiumImportPlan = {
  writes: { sourceRow: ChromiumSourceRow; domain: string; partition: SourcePartitionRead }[]
  skips: unknown[]
  skippedFamilies: Set<string>
  hasUnrepresentableSkip: boolean
}

export type ChromiumImportContext = {
  browser: DetectedBrowser
  targetPartition: string
  options: CookieImportOptions
  targetSession: Session
  stagingCookiesPath: string
  stagingAvailable: boolean
  sourceSnapshot: ChromiumCookieSnapshot
  sourceDb: InstanceType<typeof DatabaseSync> | null
  stagingDb: InstanceType<typeof DatabaseSync> | null
  targetColumnInfo: ChromiumCookieColumnInfo[] | null
  colList: string | null
  placeholders: string | null
  sourceColumns: Set<string>
  sourceRows: ChromiumSourceRow[]
  nativePlan: ChromiumImportPlan
  plannedSourceRows: Set<ChromiumSourceRow>
  partitionBySourceRow: Map<ChromiumSourceRow, SourcePartitionRead>
  sourceKey: EncryptionKeyResult | null
  imported: number
  skipped: number
  decryptFailed: number
  appBoundFailed: number
  keyringUnavailableFailed: number
  integritySkipped: number
  nonTransplantableSkipped: number
  partitionSkipped: number
  googleCookiesSkipped: number
  memoryLoaded: number
  memoryFailed: number
  domainSet: Set<string>
  decryptedCookies: DecryptedCookie[]
  scanned: ScannedChromiumCookie[]
  sourceDomainValidity: Map<string, boolean>
  insertStmt: ReturnType<InstanceType<typeof DatabaseSync>['prepare']> | null
  importScope: ImportedDomainScope
  closeStagingDb: () => void
  discardStagingFile: () => void
  disableStaging: (reason: string) => void
  undecryptableWarning?: BrowserCookieImportSummary['warning']
  warning?: BrowserCookieImportSummary['warning']
  writePhase?: ImportWritePhase
  writable?: SourceCookieToWrite[]
  result?: BrowserCookieImportResult
}
