/**
 * Where an `officecli` call runs on the host that owns the document.
 *
 * A "local" execution host is not always this machine's own filesystem: a Windows Orca can own a
 * worktree inside a WSL distro, where the binary, the fonts and the paths all belong to the guest.
 * Every office call therefore names a lane rather than assuming a native spawn.
 */
export type OfficecliLane =
  | { kind: 'native' }
  /** `undefined` distro selects the guest's default, matching `runWslProcess`. */
  | { kind: 'wsl'; distro?: string }

export const NATIVE_OFFICECLI_LANE: OfficecliLane = { kind: 'native' }

export function officecliLaneKey(lane: OfficecliLane): string {
  return lane.kind === 'native' ? 'native' : `wsl:${lane.distro ?? ''}`
}

/** A WSL guest is always POSIX, whatever the host running Orca is. */
export function officecliLaneIsPosix(lane: OfficecliLane): boolean {
  return lane.kind === 'wsl' || process.platform !== 'win32'
}
