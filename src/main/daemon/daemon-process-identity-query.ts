import { execFile, execFileSync } from 'node:child_process'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from '../startup/startup-diagnostics'
import { readWindowsProcess } from '../windows/windows-process-lookup'

const PS_IDENTITY_TIMEOUT_MS = 2_000

export type WindowsProcessIdentity = {
  commandLine: string
  startedAtMs: number | null
}

export type PsProcessIdentity = {
  commandLine: string
  startedAtMs: number | null
}

function parsePsProcessIdentity(output: string, utc = false): PsProcessIdentity {
  // BSD ps formats lstart as a fixed-width 24-character timestamp.
  const startedAtMs = Date.parse(output.slice(0, 24) + (utc ? ' UTC' : ''))
  return {
    commandLine: output.slice(24).trim(),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null
  }
}

export function getPsProcessIdentity(
  pid: number,
  options?: { utc?: boolean }
): PsProcessIdentity | null {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
      ...(options?.utc ? { env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } } : {})
    })
    return parsePsProcessIdentity(output, options?.utc)
  } catch {
    return null
  }
}

export async function getPsProcessIdentityAsync(pid: number): Promise<PsProcessIdentity | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
        {
          encoding: 'utf8',
          timeout: PS_IDENTITY_TIMEOUT_MS
        },
        (error, output) => {
          if (error) {
            reject(error)
            return
          }
          resolve(output)
        }
      )
    })
    return parsePsProcessIdentity(stdout)
  } catch {
    return null
  }
}

// Why the process table, not a per-PID CIM query: that forked powershell.exe at
// every startup (300-800ms cold); the native snapshot reads off-thread, with no child.
// Timed under ORCA_STARTUP_DIAGNOSTICS so the cold-start benchmark can attribute
// startup cost to these checks.
export async function queryWindowsProcessIdentity(
  pid: number
): Promise<WindowsProcessIdentity | null> {
  const startedAt = performance.now()
  try {
    const lookup = await readWindowsProcess(pid)
    return lookup.status === 'present' && lookup.commandLine
      ? { commandLine: lookup.commandLine, startedAtMs: lookup.startedAtMs }
      : null
  } finally {
    if (isStartupDiagnosticsEnabled()) {
      logStartupDiagnostic('daemon-pid-check', {
        t: Math.round(performance.now()),
        pid,
        ms: Math.round(performance.now() - startedAt)
      })
    }
  }
}
