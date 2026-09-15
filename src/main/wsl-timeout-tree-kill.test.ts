import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, spawnSync: spawnSyncMock }
})

const { admitProcessTreeKillMock } = vi.hoisted(() => ({ admitProcessTreeKillMock: vi.fn() }))
vi.mock('../shared/child-process/process-tree-kill-gate', () => ({
  admitProcessTreeKill: admitProcessTreeKillMock
}))

import { killIfTimedOut, killTimedOutWslProcessTree } from './wsl-timeout-tree-kill'

function withPlatform<T>(value: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('killTimedOutWslProcessTree', () => {
  afterEach(() => {
    spawnSyncMock.mockReset()
    admitProcessTreeKillMock.mockReset()
  })

  it('taskkills the tree when the gate admits it', () => {
    admitProcessTreeKillMock.mockReturnValue(true)

    withPlatform('win32', () => killTimedOutWslProcessTree(4242, 'someSite'))

    expect(admitProcessTreeKillMock).toHaveBeenCalledWith({
      pid: 4242,
      site: 'someSite',
      scope: 'win-taskkill-tree'
    })
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4242', '/t', '/f'],
      expect.objectContaining({ stdio: 'ignore', windowsHide: true, shell: false, timeout: 2_000 })
    )
  })

  it('does nothing when the gate refuses the kill', () => {
    admitProcessTreeKillMock.mockReturnValue(false)

    withPlatform('win32', () => killTimedOutWslProcessTree(4242, 'someSite'))

    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('does nothing off Windows', () => {
    admitProcessTreeKillMock.mockReturnValue(true)

    withPlatform('linux', () => killTimedOutWslProcessTree(4242, 'someSite'))

    expect(admitProcessTreeKillMock).not.toHaveBeenCalled()
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('does nothing without a pid', () => {
    admitProcessTreeKillMock.mockReturnValue(true)

    withPlatform('win32', () => killTimedOutWslProcessTree(undefined, 'someSite'))

    expect(admitProcessTreeKillMock).not.toHaveBeenCalled()
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('swallows a spawnSync failure', () => {
    admitProcessTreeKillMock.mockReturnValue(true)
    spawnSyncMock.mockImplementation(() => {
      throw new Error('spawnSync exploded')
    })

    expect(() =>
      withPlatform('win32', () => killTimedOutWslProcessTree(4242, 'someSite'))
    ).not.toThrow()
  })
})

describe('killIfTimedOut', () => {
  afterEach(() => {
    spawnSyncMock.mockReset()
    admitProcessTreeKillMock.mockReset()
  })

  it('tree-kills on an ETIMEDOUT error carrying a pid', () => {
    admitProcessTreeKillMock.mockReturnValue(true)
    const error = Object.assign(new Error('spawnSync ETIMEDOUT'), {
      code: 'ETIMEDOUT',
      pid: 777,
      status: null,
      signal: 'SIGTERM'
    })

    withPlatform('win32', () => killIfTimedOut(error, 'someSite'))

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '777', '/t', '/f'],
      expect.anything()
    )
  })

  it('ignores a non-timeout error', () => {
    admitProcessTreeKillMock.mockReturnValue(true)
    const error = Object.assign(new Error('distro unavailable'), { status: 4294967295 })

    withPlatform('win32', () => killIfTimedOut(error, 'someSite'))

    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('ignores a non-Error thrown value', () => {
    withPlatform('win32', () => killIfTimedOut('not an error', 'someSite'))
    withPlatform('win32', () => killIfTimedOut(null, 'someSite'))

    expect(spawnSyncMock).not.toHaveBeenCalled()
  })
})
