import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowsBunPtyLaunch } from './windows-bun-pty-launch'
import { readWindowsBunPtyGateRequest } from './windows-bun-pty-gate'
import {
  publishWindowsBunPtyShellPid,
  publishWindowsBunPtySpawnError,
  WindowsBunPtySpawnUnconfirmedError
} from './windows-bun-pty-spawn-receipt'

const workerPath = join(__dirname, 'windows-bun-pty-spawn-receipt.test.ts')
const neverExits = new Promise<number>(() => {})

describe('Windows Bun shell spawn confirmation', () => {
  afterEach(() => vi.useRealTimers())

  it('waits for the actual shell and preserves successful immediate exit through cleanup', async () => {
    const launch = createWindowsBunPtyLaunch(
      { file: 'shell.exe', args: [], env: {} },
      { workerPath }
    )
    const { shellPidPath } = readWindowsBunPtyGateRequest(launch.command.at(-1)!)
    const ready = vi.fn()
    let exit!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      exit = resolve
    })
    const waiting = launch.waitForSpawn(exited).then(ready)
    try {
      await Promise.resolve()
      expect(ready).not.toHaveBeenCalled()
      publishWindowsBunPtyShellPid(shellPidPath, 1234)
      exit(17)
      launch.dispose()
      await waiting
      expect(ready).toHaveBeenCalledOnce()
      expect(launch.readShellProcessId()).toBe(1234)
      expect(existsSync(dirname(shellPidPath))).toBe(false)
    } finally {
      launch.dispose()
    }
  })

  it('preserves a definite spawn error through cleanup so the caller can retry another shell', async () => {
    const launch = createWindowsBunPtyLaunch(
      { file: 'shell.exe', args: [], env: {} },
      { workerPath }
    )
    const { shellPidPath } = readWindowsBunPtyGateRequest(launch.command.at(-1)!)
    try {
      publishWindowsBunPtySpawnError(shellPidPath, new Error('spawn ENOENT'))
      expect(existsSync(`${shellPidPath}.error.pending`)).toBe(false)
      launch.dispose()
      await expect(launch.waitForSpawn(Promise.resolve(1))).rejects.toThrow('spawn ENOENT')
    } finally {
      launch.dispose()
    }
  })

  it('refuses to retry an exited gate without a receipt because its shell may have run', async () => {
    const launch = createWindowsBunPtyLaunch(
      { file: 'shell.exe', args: [], env: {} },
      { workerPath }
    )
    try {
      await expect(launch.waitForSpawn(Promise.resolve(0))).rejects.toBeInstanceOf(
        WindowsBunPtySpawnUnconfirmedError
      )
    } finally {
      launch.dispose()
    }
  })

  it('bounds the wait for a live gate that never publishes its shell identity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const launch = createWindowsBunPtyLaunch(
      { file: 'shell.exe', args: [], env: {} },
      { workerPath }
    )
    try {
      const waiting = launch.waitForSpawn(neverExits)
      const assertion = expect(waiting).rejects.toBeInstanceOf(WindowsBunPtySpawnUnconfirmedError)
      vi.setSystemTime(Date.now() + 30_001)
      await assertion
    } finally {
      launch.dispose()
    }
  })
})
