import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

const REPORT_EXTENSIONS = new Set(['.ips', '.spin', '.diag', '.dpsub'])
const MAX_REPORTS = 20
type MacosDiagnosticReport = {
  name: string
  bytes: number
  modifiedAt: string
}

export async function collectMacosReportDiagnosticIndex(
  lookbackMinutes: number
): Promise<Record<string, unknown>> {
  if (process.platform !== 'darwin') {
    return { supported: false, reason: 'not_macos' }
  }
  const cutoffMs = Date.now() - lookbackMinutes * 60 * 1000
  const roots = [
    join(homedir(), 'Library', 'Logs', 'DiagnosticReports'),
    '/Library/Logs/DiagnosticReports'
  ]
  const reports: MacosDiagnosticReport[] = []
  for (const root of roots) {
    try {
      for (const name of await readdir(root)) {
        const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
        if (!REPORT_EXTENSIONS.has(extension) || !/orca|electron/i.test(name)) {
          continue
        }
        const fullPath = join(root, name)
        const info = await stat(fullPath)
        if (info.mtimeMs < cutoffMs) {
          continue
        }
        reports.push({
          name: basename(fullPath),
          bytes: info.size,
          modifiedAt: info.mtime.toISOString()
        })
      }
    } catch {
      // Missing or protected diagnostic folders are expected on managed macOS.
    }
  }
  return {
    supported: true,
    count: reports.length,
    reports: reports.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, MAX_REPORTS)
  }
}
