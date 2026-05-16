import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import {
  formatCrashReportText,
  sanitizeCrashReportBreadcrumbs,
  sanitizeCrashReportDetails,
  type CrashReportCreateInput,
  type CrashReportRecord,
  type CrashReportStatus
} from '../../shared/crash-reporting'

const MAX_REPORTS = 5

type CrashReportFile = {
  reports: CrashReportRecord[]
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
    return this.withWrite(async (reports) => {
      let result: CrashReportRecord | null = null
      const nextReports = reports.map((report) => {
        if (report.id !== id) {
          return report
        }
        if (report.status !== 'pending') {
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
      const reports = await this.readReports()
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
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
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
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(tmpPath, `${JSON.stringify({ reports }, null, 2)}${os.EOL}`, 'utf8')
    await fs.rename(tmpPath, this.filePath)
  }
}
