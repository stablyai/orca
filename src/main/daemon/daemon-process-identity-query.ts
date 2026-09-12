import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from '../startup/startup-diagnostics'

const PS_IDENTITY_TIMEOUT_MS = 2_000

const execFileAsync = promisify(execFile)

export type WindowsProcessIdentity = {
  commandLine: string
  startedAtMs: number | null
}

export type PsProcessIdentity = {
  commandLine: string
  startedAtMs: number | null
}

function parsePsProcessIdentity(output: string): PsProcessIdentity {
  // BSD ps formats lstart as a fixed-width 24-character timestamp.
  const startedAtMs = Date.parse(output.slice(0, 24))
  return {
    commandLine: output.slice(24).trim(),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null
  }
}

export function getPsProcessIdentity(pid: number): PsProcessIdentity | null {
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000
    })
    return parsePsProcessIdentity(output)
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

export function parseWindowsProcessIdentityJson(stdout: string): WindowsProcessIdentity | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed) as { cmd?: unknown; start?: unknown }
    if (typeof parsed.cmd !== 'string' || !parsed.cmd) {
      return null
    }
    return {
      commandLine: parsed.cmd,
      startedAtMs:
        typeof parsed.start === 'number' && Number.isFinite(parsed.start) ? parsed.start : null
    }
  } catch {
    return null
  }
}

// Why: the only reliable command-line source on Windows is a CIM query, which
// costs a full powershell.exe spawn (300-800ms cold, worse under Defender).
// Async because the sync version measurably froze the Electron main thread at
// startup for the whole spawn (benchmark: ~0.5s warm, 3s timeout cap cold).
// CreationDate rides along in the same spawn so start-time verification adds
// zero extra process launches. Timed under ORCA_STARTUP_DIAGNOSTICS so the
// cold-start benchmark can attribute startup cost to these checks.
export async function queryWindowsProcessIdentity(
  pid: number
): Promise<WindowsProcessIdentity | null> {
  const startedAt = performance.now()
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
          `if ($p) { $start = $null; ` +
          `if ($p.CreationDate) { $start = [long]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }; ` +
          `@{ cmd = $p.CommandLine; start = $start } | ConvertTo-Json -Compress }`
      ],
      {
        encoding: 'utf8',
        timeout: 3_000
      }
    )
    return parseWindowsProcessIdentityJson(stdout)
  } catch {
    return null
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
