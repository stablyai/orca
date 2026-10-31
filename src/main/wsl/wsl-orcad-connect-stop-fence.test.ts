import { describe, expect, it, vi } from 'vitest'
import type { WslDistroGateNote } from '../wsl-background-distro-gate'
import { noteWslDistroMayHaveStopped, noteWslDistroWoken } from '../wsl-background-distro-gate'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type { WslDistroHolder } from './wsl-distro-holder-types'
import {
  ADOPTED_HOLDER_POLL_MS,
  fenceHolderOnStop,
  fenceTransportOnStop,
  openWslConnectStopFence
} from './wsl-orcad-connect-stop-fence'
import { WslOrcadConnectionManager } from './wsl-orcad-connection'
import { WslDistroNotRunningError } from './wsl-orcad-connection-errors'
import type { WslOrcadDeployOptions, WslOrcadLaunch } from './wsl-orcad-deploy'

function noteSource() {
  const listeners = new Set<(note: WslDistroGateNote) => void>()
  return {
    onNote: (listener: (note: WslDistroGateNote) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (note: WslDistroGateNote) => listeners.forEach((listener) => listener(note)),
    size: () => listeners.size
  }
}

function fakeTransport() {
  const exec = vi.fn(async (_command: string) => ({ stdout: '' }))
  const execWithClosedStdin = vi.fn(async (_command: string) => ({ stdout: '' }))
  const writeFile = vi.fn(async (_path: string, _contents: string) => {})
  const uploadDirectory = vi.fn(async (_local: string, _remote: string) => {})
  const members = { exec, execWithClosedStdin, writeFile, uploadDirectory }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fence only calls these four members, which the fake defines.
  const transport = members as unknown as OrcadHostTransport
  return { ...members, asTransport: () => transport }
}

describe('openWslConnectStopFence', () => {
  it('fences every spawn after a stop of its distro, and nothing before', async () => {
    const notes = noteSource()
    const fake = fakeTransport()
    const fence = openWslConnectStopFence('Ubuntu', notes.onNote)
    const fenced = fenceTransportOnStop(fake.asTransport(), fence)

    await fenced.exec('true')
    notes.emit({ kind: 'woken', distro: 'Ubuntu' })
    notes.emit({ kind: 'stopped', distro: 'Debian' })
    await fenced.writeFile('/a', 'x')
    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(fake.writeFile).toHaveBeenCalledTimes(1)

    notes.emit({ kind: 'stopped', distro: ' ubuntu ' })
    await expect(fenced.exec('true')).rejects.toBeInstanceOf(WslDistroNotRunningError)
    await expect(fenced.execWithClosedStdin?.('true')).rejects.toBeInstanceOf(
      WslDistroNotRunningError
    )
    await expect(fenced.uploadDirectory('/l', '/r')).rejects.toBeInstanceOf(
      WslDistroNotRunningError
    )
    expect(fake.exec).toHaveBeenCalledTimes(1)
    expect(fake.execWithClosedStdin).not.toHaveBeenCalled()
    expect(fake.uploadDirectory).not.toHaveBeenCalled()

    fence.dispose()
    expect(notes.size()).toBe(0)
  })

  it('a holder spawn after a stop is refused; before it, the caller’s own check still runs', async () => {
    const notes = noteSource()
    const fence = openWslConnectStopFence('Ubuntu', notes.onNote)
    const checks: boolean[] = []
    const ensureHeld = vi.fn<WslDistroHolder['ensureHeld']>(async (_distro, options) => {
      checks.push((await options?.requireRunning?.()) ?? true)
      return {
        outcome: 'adopted',
        record: { version: 1, distro: 'Ubuntu', pid: 1, creationTimeMs: null, startedAtMs: 0 }
      }
    })
    const holder: WslDistroHolder = {
      ensureHeld,
      adoptHolders: async () => [],
      release: async () => 'exited',
      releaseAll: async () => [],
      holderState: async () => 'live'
    }
    const fenced = fenceHolderOnStop(holder, fence)
    await fenced.ensureHeld('Ubuntu', { requireRunning: async () => false })
    expect(checks).toEqual([false])
    notes.emit({ kind: 'stopped', distro: 'Ubuntu' })
    await expect(fenced.ensureHeld('Ubuntu')).rejects.toBeInstanceOf(WslDistroNotRunningError)
  })
  it('an adopted holder found gone in the process table fences later spawns', async () => {
    vi.useFakeTimers()
    try {
      const notes = noteSource()
      const fence = openWslConnectStopFence('Ubuntu', notes.onNote)
      let state: 'live' | 'exited' | 'unverifiable' = 'live'
      const holderState = vi.fn(async () => state)
      const holder: WslDistroHolder = {
        ensureHeld: async () => ({
          outcome: 'adopted',
          record: { version: 1, distro: 'Ubuntu', pid: 7, creationTimeMs: null, startedAtMs: 0 }
        }),
        adoptHolders: async () => [],
        release: async () => 'exited',
        releaseAll: async () => [],
        holderState
      }
      await fenceHolderOnStop(holder, fence).ensureHeld('Ubuntu')
      state = 'unverifiable'
      await vi.advanceTimersByTimeAsync(ADOPTED_HOLDER_POLL_MS)
      expect(() => fence.assertNotStopped()).not.toThrow()
      // `wsl --terminate` kills the previous run's holder; nothing here hears its exit.
      state = 'exited'
      await vi.advanceTimersByTimeAsync(ADOPTED_HOLDER_POLL_MS)
      expect(() => fence.assertNotStopped()).toThrow(WslDistroNotRunningError)
      fence.dispose()
      const reads = holderState.mock.calls.length
      await vi.advanceTimersByTimeAsync(ADOPTED_HOLDER_POLL_MS * 3)
      expect(holderState).toHaveBeenCalledTimes(reads)
    } finally {
      vi.useRealTimers()
    }
  })
})

const TARGET = { kind: 'wsl', id: 'wsl:ubuntu', distro: 'Ubuntu', label: 'Ubuntu' } as const

describe('a no-boot connect stopped mid-deploy (E9)', () => {
  function managerWith(deploy: (options: WslOrcadDeployOptions) => Promise<WslOrcadLaunch>) {
    const fake = fakeTransport()
    const manager = new WslOrcadConnectionManager({
      deployAndLaunch: async (_distro, options = {}) => deploy(options),
      createTransport: () => fake.asTransport(),
      onChange: () => {}
    })
    return { manager, fake }
  }

  it('runs no further guest command once the user terminates the distro', async () => {
    let reachedPause: () => void = () => {}
    const deployPaused = new Promise<void>((resolve) => (reachedPause = resolve))
    let resumeDeploy: () => void = () => {}
    const resumed = new Promise<void>((resolve) => (resumeDeploy = resolve))
    const { manager, fake } = managerWith(async (options) => {
      reachedPause()
      await resumed
      await options.createTransport?.(TARGET).exec('start orcad')
      throw new Error('unreachable: the fenced exec refuses first')
    })

    const connecting = manager.ensure('Ubuntu', { requireRunning: async () => true })
    await deployPaused
    // `wsl --terminate` while the deploy is between guest commands; the holder's exit reports it.
    noteWslDistroMayHaveStopped('Ubuntu')
    resumeDeploy()

    await expect(connecting).rejects.toBeInstanceOf(WslDistroNotRunningError)
    expect(fake.exec).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('a connect the user asked for is not fenced: it may start the distro', async () => {
    const { manager, fake } = managerWith(async (options) => {
      noteWslDistroMayHaveStopped('Ubuntu')
      noteWslDistroWoken('Ubuntu')
      await options.createTransport?.(TARGET).exec('start orcad')
      throw new Error('stop here')
    })
    await expect(manager.ensure('Ubuntu')).rejects.toThrow('stop here')
    expect(fake.exec).toHaveBeenCalledTimes(1)
    await manager.dispose()
  })
})
