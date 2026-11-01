import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGate from '../wsl-background-distro-gate'
import type * as ShellOwnedPathTarget from './shell-owned-path-target'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  readWslDistroRunningState: vi.fn(),
  pathExists: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, fn)
  },
  shell: {},
  dialog: {}
}))
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGate>()),
  readWslDistroRunningState: mocks.readWslDistroRunningState
}))
vi.mock('./shell-owned-path-target', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellOwnedPathTarget>()),
  pathExists: mocks.pathExists
}))

import { registerShellHandlers } from './shell'

const UNC_FILE = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\README.md'
const HOST_FILE = 'C:\\repo\\README.md'

function pathsExist(paths: string[]): Promise<unknown> {
  const handler = mocks.handlers.get('shell:pathsExist')
  if (!handler) {
    throw new Error('shell:pathsExist is not registered')
  }
  return handler(null, paths)
}

function pathExists(path: string, options?: { wakeWslDistro?: boolean }): Promise<unknown> {
  const handler = mocks.handlers.get('shell:pathExists')
  if (!handler) {
    throw new Error('shell:pathExists is not registered')
  }
  return handler(null, path, options)
}

describe('shell:pathsExist never starts a stopped WSL distro (E9)', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.handlers.clear()
    mocks.readWslDistroRunningState.mockReset().mockResolvedValue('stopped')
    mocks.pathExists.mockReset().mockResolvedValue(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: path-existence handlers never read the store.
    registerShellHandlers({} as never)
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('refuses only the stopped distro path, never touching it, and answers the rest', async () => {
    await expect(pathsExist([HOST_FILE, UNC_FILE])).resolves.toEqual([
      true,
      { error: expect.stringContaining("WSL distro 'Ubuntu' is not running") }
    ])
    expect(mocks.pathExists).not.toHaveBeenCalledWith(UNC_FILE)
  })

  it('answers host paths and running-distro paths as before', async () => {
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    await expect(pathsExist([HOST_FILE, UNC_FILE])).resolves.toEqual([true, true])
    expect(mocks.pathExists).toHaveBeenCalledWith(UNC_FILE)
  })

  it('shell:pathExists refuses a background check of a stopped distro path without touching it', async () => {
    await expect(pathExists(UNC_FILE)).rejects.toThrow(
      "WSL distro 'Ubuntu' is not running. Open a terminal in it to start it."
    )
    expect(mocks.pathExists).not.toHaveBeenCalled()
    await expect(pathExists(HOST_FILE)).resolves.toBe(true)
  })

  it('shell:pathExists checks a stopped distro path for a click, a user act', async () => {
    await expect(pathExists(UNC_FILE, { wakeWslDistro: true })).resolves.toBe(true)
    expect(mocks.pathExists).toHaveBeenCalledWith(UNC_FILE)
  })
})
