import {
  parsePtyProcessCeilingState,
  type PtyProcessCeilingState
} from '../../shared/pty-process-ceiling-state'
export type ParsedDaemonPid = {
  pid: number
  startedAtMs: number | null
  entryPath: string | null
  appVersion: string | null
  launchNonce: string | null
  linuxStartTicks: string | null
  bootId: string | null
  spawnerExecPath: string | null
  /** Self-detected systemd scope; null for unscoped or older daemons. */
  cgroupUnit: string | null
  /** Null when the daemon predates the ceiling report. */
  processCeiling?: PtyProcessCeilingState | null
}

/** Require a byte after the PID digits: a torn prefix can name an unrelated process and misdirect quarantine. */
export function salvagePidFromCorruptDaemonRecord(contents: string): number | null {
  const match = /"pid"\s*:\s*(\d+)(?=\D)/.exec(contents)
  if (!match) {
    return null
  }
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseDaemonPidFile(contents: string): ParsedDaemonPid | null {
  const trimmed = contents.trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (isRecord(parsed) && typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) {
      return {
        pid: parsed.pid,
        startedAtMs:
          typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
            ? parsed.startedAtMs
            : null,
        entryPath: typeof parsed.entryPath === 'string' ? parsed.entryPath : null,
        appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : null,
        launchNonce: typeof parsed.launchNonce === 'string' ? parsed.launchNonce : null,
        linuxStartTicks: typeof parsed.linuxStartTicks === 'string' ? parsed.linuxStartTicks : null,
        bootId: typeof parsed.bootId === 'string' ? parsed.bootId : null,
        spawnerExecPath: typeof parsed.spawnerExecPath === 'string' ? parsed.spawnerExecPath : null,
        cgroupUnit: typeof parsed.cgroupUnit === 'string' ? parsed.cgroupUnit : null,
        processCeiling: parsePtyProcessCeilingState(parsed.processCeiling)
      }
    }
  } catch {
    // Legacy daemons wrote the pid file as a bare integer.
  }

  const pid = Number(trimmed)
  return Number.isFinite(pid)
    ? {
        pid,
        startedAtMs: null,
        entryPath: null,
        appVersion: null,
        launchNonce: null,
        linuxStartTicks: null,
        bootId: null,
        spawnerExecPath: null,
        cgroupUnit: null,
        processCeiling: null
      }
    : null
}
