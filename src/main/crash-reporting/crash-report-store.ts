import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { grantDirAclAsync, isPermissionError } from '../win32-utils'
import {
  formatCrashReportText,
  sanitizeCrashReportBreadcrumbs,
  sanitizeCrashReportDetails,
  type CrashReportCreateInput,
  type CrashReportRecord,
  type CrashReportStatus
} from '../../shared/crash-reporting'
import * as boundedFileReader from '../../shared/node-bounded-file-reader'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'

const MAX_REPORTS = 5
export const MAX_CRASH_REPORT_FILE_BYTES = 4 * 1024 * 1024
export const MAX_CRASH_REPORT_JSON_STRUCTURAL_TOKENS = 1_000_000
export const MAX_CRASH_REPORT_JSON_NESTING_DEPTH = 128
const RELATED_CRASH_WINDOW_MS = 5_000
const WINDOWS_FILE_OPERATION_RETRY_DELAYS_MS = [50, 100, 150, 200, 250]

type CrashReportFile = {
  reports: CrashReportRecord[]
}

function isRelatedCrashEvent(anchor: CrashReportRecord, candidate: CrashReportRecord): boolean {
  if (anchor.id === candidate.id || candidate.status !== 'pending') {
    return false
  }
  const anchorTime = Date.parse(anchor.createdAt)
  const candidateTime = Date.parse(candidate.createdAt)
  if (!Number.isFinite(anchorTime) || !Number.isFinite(candidateTime)) {
    return false
  }
  return (
    Math.abs(anchorTime - candidateTime) <= RELATED_CRASH_WINDOW_MS &&
    anchor.reason === candidate.reason &&
    anchor.exitCode === candidate.exitCode &&
    anchor.appVersion === candidate.appVersion &&
    anchor.platform === candidate.platform
  )
}

function isRetryableWindowsFileOperationError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

async function runCrashReportFileOperationWithWindowsRecovery<T>(
  directory: string,
  operation: () => Promise<T>
): Promise<T> {
  let repairedAcl = false
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !isRetryableWindowsFileOperationError(error) ||
        attempt >= WINDOWS_FILE_OPERATION_RETRY_DELAYS_MS.length
      ) {
        throw error
      }
      if (!repairedAcl && isPermissionError(error)) {
        repairedAcl = true
        try {
          // Why: Chromium can reset userData ACLs before startup capture or
          // recovery, so both the crash write and next prompt must repair it.
          await grantDirAclAsync(directory)
        } catch {
          // The bounded retry below still handles transient file locks.
        }
      }
      await wait(WINDOWS_FILE_OPERATION_RETRY_DELAYS_MS[attempt])
    }
  }
}

export class CrashReportStore {
  private writeChain = Promise.resolve()

  constructor(private readonly filePath: string) {}

  static fromUserData(userDataPath = app.getPath('userData')): CrashReportStore {
    return new CrashReportStore(path.join(userDataPath, 'crash-reports.json'))
  }

  async record(input: CrashReportCreateInput): Promise<CrashReportRecord> {
    return this.withWrite(async (reports) => {
      const report: CrashReportRecord = {
        ...input,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        status: 'pending',
        details: sanitizeCrashReportDetails(input.details),
        breadcrumbs: sanitizeCrashReportBreadcrumbs(input.breadcrumbs)
      }
      return {
        reports: [report, ...reports].slice(0, MAX_REPORTS),
        result: report
      }
    })
  }

  async getLatestPending(): Promise<CrashReportRecord | null> {
    const reports = await this.readReports()
    return reports.find((report) => report.status === 'pending') ?? null
  }

  async listRecent(): Promise<CrashReportRecord[]> {
    return this.readReports()
  }

  async markSent(id: string): Promise<CrashReportRecord | null> {
    return this.transitionPending(id, 'sent')
  }

  async markDismissedSent(id: string): Promise<CrashReportRecord | null> {
    return this.transitionStatus(id, 'dismissed', 'sent')
  }

  async dismiss(id: string): Promise<CrashReportRecord | null> {
    return this.transitionPending(id, 'dismissed')
  }

  async formatDiagnosticText(id: string, notes?: string): Promise<string | null> {
    const reports = await this.readReports()
    const report = reports.find((candidate) => candidate.id === id)
    return report ? formatCrashReportText(report, notes) : null
  }

  async getById(id: string): Promise<CrashReportRecord | null> {
    const reports = await this.readReports()
    return reports.find((report) => report.id === id) ?? null
  }

  private async transitionPending(
    id: string,
    status: Exclude<CrashReportStatus, 'pending'>
  ): Promise<CrashReportRecord | null> {
    return this.transitionStatus(id, 'pending', status)
  }

  private async transitionStatus(
    id: string,
    from: CrashReportStatus,
    status: Exclude<CrashReportStatus, 'pending'>
  ): Promise<CrashReportRecord | null> {
    return this.withWrite(async (reports) => {
      let result: CrashReportRecord | null = null
      const anchor = reports.find((report) => report.id === id)
      const nextReports = reports.map((report) => {
        if (report.id !== id) {
          // Why: one Electron crash can emit GPU/Network/renderer exits in a
          // burst. Once one report is handled, sibling pending records should
          // not re-open the crash prompt as separate crashes.
          if (anchor && anchor.status === from && isRelatedCrashEvent(anchor, report)) {
            return { ...report, status: 'dismissed' as const }
          }
          return report
        }
        if (report.status !== from) {
          result = report
          return report
        }
        result = { ...report, status }
        return result
      })
      return { reports: nextReports, result }
    })
  }

  private async withWrite<T>(
    mutate: (reports: CrashReportRecord[]) => Promise<{ reports: CrashReportRecord[]; result: T }>
  ): Promise<T> {
    const run = this.writeChain.then(async () => {
      // Why: awaiting writeChain from inside its own callback would deadlock;
      // this writer already has exclusive ownership and can read disk directly.
      const reports = await this.readReportsFromDisk()
      const { reports: nextReports, result } = await mutate(reports)
      await this.writeReports(nextReports)
      return result
    })
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async readReports(): Promise<CrashReportRecord[]> {
    // Why: renderer recovery can query the one-shot startup prompt while the
    // crash write is still in flight. Wait so a successful capture is visible.
    await this.writeChain
    return this.readReportsFromDisk()
  }

  private async readReportsFromDisk(): Promise<CrashReportRecord[]> {
    try {
      const raw = await runCrashReportFileOperationWithWindowsRecovery(
        path.dirname(this.filePath),
        async () =>
          (
            await boundedFileReader.readNodeFileWithinLimit(
              this.filePath,
              MAX_CRASH_REPORT_FILE_BYTES
            )
          ).buffer.toString('utf8')
      )
      assertJsonTextStructureWithinLimits(raw, {
        structuralTokens: MAX_CRASH_REPORT_JSON_STRUCTURAL_TOKENS,
        nestingDepth: MAX_CRASH_REPORT_JSON_NESTING_DEPTH
      })
      const parsed = JSON.parse(raw) as Partial<CrashReportFile>
      return Array.isArray(parsed.reports) ? parsed.reports.slice(0, MAX_REPORTS) : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[crash-reporting] Failed to read crash reports:', error)
      }
      return []
    }
  }

  private async writeReports(reports: CrashReportRecord[]): Promise<void> {
    const directory = path.dirname(this.filePath)
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`
    try {
      await runCrashReportFileOperationWithWindowsRecovery(directory, async () => {
        const { serialized } = stringifyJsonWithinByteLimit(
          { reports },
          MAX_CRASH_REPORT_FILE_BYTES - Buffer.byteLength(os.EOL),
          2
        )
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(tmpPath, `${serialized}${os.EOL}`, 'utf8')
        await fs.rename(tmpPath, this.filePath)
      })
    } finally {
      // Why: disk-full and terminal rename failures must not accumulate a new
      // orphaned multi-report temp file after every crash.
      await fs.rm(tmpPath, { force: true }).catch(() => {})
    }
  }
}
