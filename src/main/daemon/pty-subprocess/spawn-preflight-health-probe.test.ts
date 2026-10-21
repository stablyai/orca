import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nodePty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => nodePty)

import { runPtySpawnHealthProbe } from './spawn-preflight'

function exitingPty(exitCode: number) {
  let listener: ((event: { exitCode: number }) => void) | undefined
  const proc = {
    kill: vi.fn(),
    onExit: vi.fn((callback: typeof listener) => {
      listener = callback
      queueMicrotask(() => listener?.({ exitCode }))
      return { dispose: () => (listener = undefined) }
    })
  }
  nodePty.spawn.mockReturnValue(proc)
  return proc
}

describe('PTY spawn health probe teardown', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  let userDataPath: string

  beforeEach(() => {
    nodePty.spawn.mockReset()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-pty-health-probe-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('kills a cleanly exited Windows probe so its conout worker cannot hold the process open', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const proc = exitingPty(0)

    await expect(runPtySpawnHealthProbe()).resolves.toBeUndefined()

    expect(nodePty.spawn.mock.calls[0]![2]).toMatchObject({ useConptyDll: true })
    expect(proc.kill).toHaveBeenCalledOnce()
  })

  it('kills a Windows probe that exits non-zero', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const proc = exitingPty(1)

    await expect(runPtySpawnHealthProbe()).rejects.toThrow(/exited with code 1/)
    expect(proc.kill).toHaveBeenCalledOnce()
  })

  it('leaves a cleanly exited POSIX probe alone', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const proc = exitingPty(0)

    await expect(runPtySpawnHealthProbe()).resolves.toBeUndefined()

    expect(nodePty.spawn.mock.calls[0]![2]).not.toHaveProperty('useConptyDll')
    expect(proc.kill).not.toHaveBeenCalled()
  })
})
