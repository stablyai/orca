import os from 'node:os'

// Darwin 25 = macOS 26 Tahoe: reentrant frame writes can deadlock scene-backed AppKit windows in FrontBoardServices.
export function isMacosTahoeOrNewer(darwinRelease: string = os.release()): boolean {
  const major = Number.parseInt(darwinRelease, 10)
  return Number.isFinite(major) && major >= 25
}
