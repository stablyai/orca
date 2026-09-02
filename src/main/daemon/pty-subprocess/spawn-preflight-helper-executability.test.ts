import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as fs from 'node:fs'
import type { Stats } from 'node:fs'

const DAEMON_CWD = '/orca/userData'
const RELEASE_HELPER = '/orca/node_modules/node-pty/build/Release/spawn-helper'
const DEBUG_HELPER = '/orca/node_modules/node-pty/build/Debug/spawn-helper'
const PREBUILD_HELPER = '/orca/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'

const { statSyncMock, candidatesMock } = vi.hoisted(() => ({
  statSyncMock: vi.fn(),
  candidatesMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, statSync: statSyncMock }
})

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

vi.mock('../../providers/local-pty-utils', () => ({
  ensureNodePtySpawnHelperExecutable: vi.fn(),
  getNodePtySpawnHelperCandidates: candidatesMock,
  validateWorkingDirectoryAsync: vi.fn(),
  WorkingDirectoryValidationAbortedError: class extends Error {}
}))

vi.mock('../../providers/pty-default-cwd', () => ({
  resolveSafePtyDefaultCwd: () => DAEMON_CWD
}))

import { preflightPtySpawnHealth } from './spawn-preflight'

function dirStats(): Stats {
  return { isDirectory: () => true, isFile: () => false, mode: 0o040755 } as Stats
}

function helperStats(mode: number): Stats {
  return { isDirectory: () => false, isFile: () => true, mode } as Stats
}

/** Only the paths in `helpers` exist; everything else stats as ENOENT. */
function stubInstalledHelpers(helpers: Record<string, number>): void {
  statSyncMock.mockImplementation((path: string) => {
    if (path === DAEMON_CWD) {
      return dirStats()
    }
    const mode = helpers[path]
    if (mode === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), {
        code: 'ENOENT'
      })
    }
    return helperStats(mode)
  })
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  statSyncMock.mockReset()
  candidatesMock.mockReturnValue([RELEASE_HELPER, DEBUG_HELPER, PREBUILD_HELPER])
  vi.spyOn(process, 'cwd').mockReturnValue(DAEMON_CWD)
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

describe('preflightPtySpawnHealth node-pty helper checks', () => {
  it('passes when an installed helper is executable', () => {
    stubInstalledHelpers({ [RELEASE_HELPER]: 0o100755 })

    expect(preflightPtySpawnHealth()).toBe(true)
  })

  it('rejects a helper that exists but is not executable', () => {
    // The regression: an isFile() probe passed on the packaged 644 prebuild helper, so the
    // preflight cleared a spawn that node-pty then failed with EACCES.
    stubInstalledHelpers({ [PREBUILD_HELPER]: 0o100644 })

    expect(() => preflightPtySpawnHealth()).toThrow(/EACCES \(errno 13/)
    expect(() => preflightPtySpawnHealth()).toThrow(new RegExp(`helper='${PREBUILD_HELPER}'`))
  })

  it('does not blame a missing install when the helper is merely unexecutable', () => {
    stubInstalledHelpers({ [PREBUILD_HELPER]: 0o100644 })

    expect(() => preflightPtySpawnHealth()).toThrow(/not executable/)
    expect(() => preflightPtySpawnHealth()).not.toThrow(/is gone/)
  })

  it('accepts an executable fallback helper when the preferred one is unexecutable', () => {
    stubInstalledHelpers({ [RELEASE_HELPER]: 0o100644, [PREBUILD_HELPER]: 0o100755 })

    expect(preflightPtySpawnHealth()).toBe(true)
  })

  it('still reports a missing node-pty install as ENOENT', () => {
    stubInstalledHelpers({})

    expect(() => preflightPtySpawnHealth()).toThrow(/node-pty install is gone/)
    expect(() => preflightPtySpawnHealth()).toThrow(/ENOENT \(errno 2/)
  })
})
