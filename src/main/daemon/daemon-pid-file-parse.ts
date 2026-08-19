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
