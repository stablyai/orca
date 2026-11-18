// The daemon installs its reader so the memory collector need not import the daemon module graph.
let readLocalDaemonPid: () => number | null = () => null

export function setLocalDaemonPidReader(reader: () => number | null): void {
  readLocalDaemonPid = reader
}

export function getLocalDaemonPid(): number | null {
  return readLocalDaemonPid()
}

// The pid the current daemon generation authenticated as: memory only, safe on any timer.
let readKnownLocalDaemonPid: () => number | null = () => null

export function setKnownLocalDaemonPidReader(reader: () => number | null): void {
  readKnownLocalDaemonPid = reader
}

export function getKnownLocalDaemonPid(): number | null {
  return readKnownLocalDaemonPid()
}
