import os from 'node:os'

// Why: Darwin 25.x = macOS 26 (Tahoe), where AppKit windows are scene-backed and
// re-entrant frame updates can self-deadlock the main thread in FrontBoardServices.
export function isMacosTahoeOrNewer(darwinRelease: string = os.release()): boolean {
  const major = Number.parseInt(darwinRelease, 10)
  return Number.isFinite(major) && major >= 25
}
