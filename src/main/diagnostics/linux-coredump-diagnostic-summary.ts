import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { redactValue } from '../observability/redactor'

const execFileAsync = promisify(execFile)
const COREDUMP_TIMEOUT_MS = 4_000

export async function collectLinuxCoredumpDiagnosticSummary(
  lookbackMinutes: number
): Promise<Record<string, unknown>> {
  if (process.platform !== 'linux') {
    return { supported: false, reason: 'not_linux' }
  }
  const since = `${Math.max(1, Math.floor(lookbackMinutes))} minutes ago`
  const { stdout } = await execFileAsync(
    'coredumpctl',
    ['--no-pager', '--json=short', '--since', since, 'list'],
    { timeout: COREDUMP_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
  )
  const rows = parseJsonLines(stdout)
  return {
    supported: true,
    count: rows.length,
    coredumps: rows
      .filter((row) => /orca|electron/i.test(JSON.stringify(row)))
      .slice(0, 20)
      .map((row) => redactObject(row))
  }
}

export async function collectLinuxJournalDiagnosticSummary(
  lookbackMinutes: number
): Promise<Record<string, unknown>> {
  if (process.platform !== 'linux') {
    return { supported: false, reason: 'not_linux' }
  }
  const since = `${Math.max(1, Math.floor(lookbackMinutes))} minutes ago`
  const { stdout } = await execFileAsync(
    'journalctl',
    ['--user', '--no-pager', '-n', '50', '-o', 'json', '--since', since],
    { timeout: COREDUMP_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
  )
  return {
    supported: true,
    entries: parseJsonLines(stdout)
      .filter((row) => /orca|electron/i.test(JSON.stringify(row)))
      .slice(0, 20)
      .map((row) => redactObject(row))
  }
}

function parseJsonLines(stdout: string): unknown[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
}

function redactObject(value: unknown): unknown {
  return redactValue(value, 'server')
}
