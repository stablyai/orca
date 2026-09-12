import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveHangWatchdogWorkerPath } from './hang-watchdog-worker-path'

describe('resolveHangWatchdogWorkerPath', () => {
  it('resolves packaged workers inside app.asar', () => {
    const appPath = join('/apps', 'orca', 'app.asar')
    expect(resolveHangWatchdogWorkerPath(appPath, true)).toBe(
      join(appPath, 'out', 'main', 'main-thread-hang-watchdog-entry.js')
    )
  })

  it('uses an adjacent entry when the dev app path is out/main', () => {
    const appPath = join('/repo', 'out', 'main')
    const adjacent = join(appPath, 'main-thread-hang-watchdog-entry.js')
    const pathExists = vi.fn((candidate: string) => candidate === adjacent)
    expect(resolveHangWatchdogWorkerPath(appPath, false, pathExists)).toBe(adjacent)
  })

  it('resolves through out/main from a dev project root', () => {
    const appPath = join('/repo', 'orca')
    expect(resolveHangWatchdogWorkerPath(appPath, false, () => false)).toBe(
      join(appPath, 'out', 'main', 'main-thread-hang-watchdog-entry.js')
    )
  })
})
