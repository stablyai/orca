import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type * as DistroGate from '../wsl-background-distro-gate'
import type { DaemonServer } from './daemon-server'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import { parseWslDistroHold } from '../../shared/wsl-distro-stopped-hold'

const readState = vi.hoisted(() =>
  vi.fn(
    async (_distro: string, _opts?: unknown): Promise<'running' | 'stopped' | 'unverifiable'> =>
      'stopped'
  )
)
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof DistroGate>()),
  readWslDistroRunningState: readState
}))

const WSL_CWD = '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
const SESSION_ID = 'wt-1::/home/jin/repo@@pane1'

describe('a passive restore of a WSL bridge pane (E9)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let spawns: number

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    readState.mockReset()
    readState.mockResolvedValue('stopped')
    spawns = 0
    const harness = await startDaemonAdapterHarness(() => {
      spawns++
      return createMockSubprocess()
    })
    ;({ dir, server, adapter } = harness)
  })

  afterEach(async () => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    adapter.dispose()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  const restore = (extra: { wslPassiveRestore?: true; isNewSession?: boolean } = {}) =>
    adapter.spawn({ cols: 80, rows: 24, cwd: WSL_CWD, sessionId: SESSION_ID, ...extra })

  it('is held, starting nothing, when a settled read finds the distro stopped', async () => {
    const error = await restore({ wslPassiveRestore: true }).catch((caught: unknown) => caught)
    expect(error instanceof Error ? parseWslDistroHold(error.message) : null).toEqual({
      distro: 'Ubuntu',
      state: 'stopped'
    })
    expect(spawns).toBe(0)
    expect(readState).toHaveBeenCalledWith('Ubuntu', { retryUnverifiable: true })
  })

  it('starts as before once a settled read proves the distro running', async () => {
    readState.mockResolvedValue('running')
    await restore({ wslPassiveRestore: true })
    expect(spawns).toBe(1)
  })

  // As every E9 gate: an unanswered read is not a running distro, and the Start card still helps.
  it('holds when the read cannot tell, too', async () => {
    readState.mockResolvedValue('unverifiable')
    const error = await restore({ wslPassiveRestore: true }).catch((caught: unknown) => caught)
    // Named as such, so the card says Orca couldn't check rather than that the distro stopped.
    expect(error instanceof Error ? parseWslDistroHold(error.message) : null).toEqual({
      distro: 'Ubuntu',
      state: 'unverifiable'
    })
    expect(spawns).toBe(0)
  })

  it("starts a user's restore and a new terminal without reading the distro", async () => {
    await restore()
    await adapter.spawn({
      cols: 80,
      rows: 24,
      cwd: WSL_CWD,
      isNewSession: true,
      wslPassiveRestore: true
    })
    expect(spawns).toBe(2)
    expect(readState).not.toHaveBeenCalled()
  })

  it('leaves a non-WSL restore alone', async () => {
    await adapter.spawn({
      cols: 80,
      rows: 24,
      cwd: 'C:\\repo',
      sessionId: 'wt-1::C:/repo@@pane1',
      wslPassiveRestore: true
    })
    expect(spawns).toBe(1)
    expect(readState).not.toHaveBeenCalled()
  })

  // The cwd alone names the distro: a PowerShell pane of a host-path folder still runs in the guest.
  describe('a non-WSL shell whose cwd is a WSL UNC path', () => {
    const uncRestore = (cwd: string, extra: { wslPassiveRestore?: true } = {}) =>
      adapter.spawn({
        cols: 80,
        rows: 24,
        cwd,
        sessionId: 'wt-1::C:/folder@@pane1',
        shellOverride: 'powershell.exe',
        ...extra
      })

    it.each([
      ['\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'],
      ['\\\\wsl$\\Ubuntu\\home\\jin\\repo']
    ])('holds its passive restore while the distro is stopped (%s)', async (cwd) => {
      const error = await uncRestore(cwd, { wslPassiveRestore: true }).catch(
        (caught: unknown) => caught
      )
      expect(error instanceof Error ? parseWslDistroHold(error.message) : null).toEqual({
        distro: 'Ubuntu',
        state: 'stopped'
      })
      expect(spawns).toBe(0)
    })

    it("starts the user's own launch without reading the distro", async () => {
      await uncRestore('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
      expect(spawns).toBe(1)
      expect(readState).not.toHaveBeenCalled()
    })

    it('leaves a host cwd alone', async () => {
      await uncRestore('C:\\folder', { wslPassiveRestore: true })
      expect(spawns).toBe(1)
      expect(readState).not.toHaveBeenCalled()
    })
  })

  describe('a background start from main (orchestration, automations, recovery)', () => {
    const fresh = () =>
      adapter.spawn({
        cols: 80,
        rows: 24,
        cwd: WSL_CWD,
        isNewSession: true,
        wslBackgroundStart: true
      })

    it('holds a new terminal too, starting nothing, while the distro is stopped', async () => {
      const error = await fresh().catch((caught: unknown) => caught)
      expect(error instanceof Error ? parseWslDistroHold(error.message) : null).toEqual({
        distro: 'Ubuntu',
        state: 'stopped'
      })
      expect(spawns).toBe(0)
    })

    it('holds it as unverifiable when the read cannot tell', async () => {
      readState.mockResolvedValue('unverifiable')
      const error = await fresh().catch((caught: unknown) => caught)
      expect(error instanceof Error ? parseWslDistroHold(error.message) : null).toEqual({
        distro: 'Ubuntu',
        state: 'unverifiable'
      })
      expect(spawns).toBe(0)
    })

    it('holds its restore of a saved pane', async () => {
      const held = await adapter
        .spawn({
          cols: 80,
          rows: 24,
          cwd: WSL_CWD,
          sessionId: SESSION_ID,
          wslBackgroundStart: true
        })
        .catch((caught: unknown) => caught)
      expect(held instanceof Error ? parseWslDistroHold(held.message) : null).toEqual({
        distro: 'Ubuntu',
        state: 'stopped'
      })
      expect(spawns).toBe(0)
    })

    it('starts once a settled read proves the distro running', async () => {
      readState.mockResolvedValue('running')
      await fresh()
      expect(spawns).toBe(1)
    })

    it('leaves a non-WSL start alone', async () => {
      await adapter.spawn({
        cols: 80,
        rows: 24,
        cwd: 'C:\\repo',
        isNewSession: true,
        wslBackgroundStart: true
      })
      expect(spawns).toBe(1)
      expect(readState).not.toHaveBeenCalled()
    })
  })
})
