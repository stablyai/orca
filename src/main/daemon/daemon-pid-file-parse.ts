export type ParsedDaemonPid = {
  pid: number
  startedAtMs: number | null
  entryPath: string | null
  appVersion: string | null
  launchNonce: string | null
  linuxStartTicks: string | null
  bootId: string | null
  spawnerExecPath: string | null
}

/**
 * Best-effort pid recovery from a record parseDaemonPidFile rejected. The pid is the first key
 * JSON.stringify writes, so a torn write usually preserves it; it gates whether a corrupt record
 * may be quarantined (a process still answering for this pid keeps its conservative veto).
 *
 * The digit run must be terminated by a following non-digit byte: a torn write can cut inside
 * the digits, and a truncated prefix is a different pid — probing it attributes an unrelated
 * process's liveness to this record (a dead prefix would quarantine on false evidence; an
 * immortal one, e.g. Windows System pid 4, would veto forever). Digits at end-of-bytes are
 * therefore unsalvageable; the writer of such a prefix died mid-write, so no probe is needed.
 */
export function salvagePidFromCorruptDaemonRecord(contents: string): number | null {
  const match = /"pid"\s*:\s*(\d+)(?=\D)/.exec(contents)
  if (!match) {
    return null
  }
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export function parseDaemonPidFile(contents: string): ParsedDaemonPid | null {
  const trimmed = contents.trim()
  try {
    const parsed = JSON.parse(trimmed) as {
      pid?: unknown
      startedAtMs?: unknown
      entryPath?: unknown
      appVersion?: unknown
      launchNonce?: unknown
      linuxStartTicks?: unknown
      bootId?: unknown
      spawnerExecPath?: unknown
    }
    if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) {
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
        spawnerExecPath: typeof parsed.spawnerExecPath === 'string' ? parsed.spawnerExecPath : null
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
        spawnerExecPath: null
      }
    : null
}
