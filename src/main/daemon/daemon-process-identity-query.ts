import { runProcess, runProcessSync } from '../../shared/child-process/run-process'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from '../startup/startup-diagnostics'

const PS_IDENTITY_TIMEOUT_MS = 2_000
const WINDOWS_IDENTITY_TIMEOUT_MS = 3_000

function psIdentitySpec(pid: number): {
  program: string
  args: string[]
  timeoutMs: number
} {
  return {
    program: 'ps',
    args: ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
    timeoutMs: PS_IDENTITY_TIMEOUT_MS
  }
}

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

/**
 * Narrow sync path, deliberately kept: the only caller is the synchronous
 * `getProcessStartedAtMs`, which the orcad instance lock acquires under.
 * Anything reachable from an `ipcMain` reply must use the async twin below.
 */
export function getPsProcessIdentity(pid: number): PsProcessIdentity | null {
  try {
    const result = runProcessSync(psIdentitySpec(pid))
    // Why null over a parse: a non-zero or timed-out `ps` is loss of contact, never a verdict.
    return result.code === 0 && !result.timedOut ? parsePsProcessIdentity(result.stdout) : null
  } catch {
    return null
  }
}

export async function getPsProcessIdentityAsync(pid: number): Promise<PsProcessIdentity | null> {
  try {
    const result = await runProcess(psIdentitySpec(pid))
    return result.code === 0 && !result.timedOut ? parsePsProcessIdentity(result.stdout) : null
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
    const result = await runProcess({
      program: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; ` +
          `if ($p) { $start = $null; ` +
          `if ($p.CreationDate) { $start = [long]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }; ` +
          `@{ cmd = $p.CommandLine; start = $start } | ConvertTo-Json -Compress }`
      ],
      timeoutMs: WINDOWS_IDENTITY_TIMEOUT_MS
    })
    // Why the code guard: runProcess reports a failed query as an exit code, and a
    // partial stdout must read as "no contact", never as a missing command line.
    if (result.code !== 0 || result.timedOut) {
      return null
    }
    return parseWindowsProcessIdentityJson(result.stdout)
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
