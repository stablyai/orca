// The daemon installs its reader so the memory collector need not import the daemon module graph.
let readLocalDaemonPid: () => number | null = () => null

export function setLocalDaemonPidReader(reader: () => number | null): void {
  readLocalDaemonPid = reader
}

export function getLocalDaemonPid(): number | null {
  return readLocalDaemonPid()
}
