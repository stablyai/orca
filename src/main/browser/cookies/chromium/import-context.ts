import type { Session } from 'electron'
import type { BrowserCookieImportSummary } from '../../../../shared/browser-workspace-types'
import type { CookieImportOptions } from '../browser-cookie-import-pipeline'
import type { ImportedCookieFields, ImportWritePlanResult } from '../browser-cookie-import-write'
import type { SourcePartitionRead } from '../sources/browser-cookie-source-partition'
import type { ChromiumCookieSnapshot } from '../../chromium-cookie-snapshot'
import type { EncryptionKeyResult } from '../sources/browser-cookie-sqlite'
import type { DetectedBrowser } from '../sources/browser-cookie-detection-types'

export type ChromiumSourceRow = Record<string, unknown>

export type DecryptedCookie = Omit<ImportedCookieFields, 'url'> & {
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  partition: SourcePartitionRead
}

export type ChromiumImportPlan = ImportWritePlanResult<{
  sourceRow: ChromiumSourceRow
  domain: string
  partition: SourcePartitionRead
}>

export type ChromiumImportContext = {
  browser: DetectedBrowser
  options: CookieImportOptions
  targetSession: Session
  sourceSnapshot: ChromiumCookieSnapshot
  sourceRows: ChromiumSourceRow[]
  nativePlan: ChromiumImportPlan
  plannedSourceRows: Set<ChromiumSourceRow>
  partitionBySourceRow: Map<ChromiumSourceRow, SourcePartitionRead>
  sourceKey: EncryptionKeyResult | null
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
  sourceDomainValidity: Map<string, boolean>
  undecryptableWarning?: BrowserCookieImportSummary['warning']
}
