// verify-15a 5e: `wsl --terminate` exited a live bridge pane with code 1, which closed its tab.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslRunningDistrosRead } from '../../../../wsl/discovery/wsl-background-distro-gate'
import type { DaemonPtyAdapter } from '../daemon-pty-adapter'
import type { DaemonServer } from '../../../server/daemon-server'
import { WslBridgeBootIdentity } from '../../wsl/daemon-wsl-bridge-boot-identity'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

type Exit = { id: string; code: number; cause?: unknown }

describe('a WSL bridge pane exit', () => {
  let dir: string
  let historyDir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let subprocesses: ReturnType<typeof createMockSubprocess>[]
  let running: () => Promise<WslRunningDistrosRead>
  const readRunning = vi.fn(() => running())
  // The distro's boot id each read returns; never a real wsl.exe.
  let bootIds: string[]
  const readBootId = vi.fn(async () => (bootIds.length > 1 ? bootIds.shift()! : bootIds[0]!))
  const noteMayHaveStopped = vi.fn()

  beforeEach(async () => {
    historyDir = mkdtempSync(join(tmpdir(), 'orca-distro-loss-history-'))
    subprocesses = []
    running = async () => ({ status: 'confirmed', distros: ['Ubuntu'] })
    readRunning.mockClear()
    bootIds = ['boot-1']
    readBootId.mockClear()
    noteMayHaveStopped.mockClear()
    const harness = await startDaemonAdapterHarness(
      () => {
        const subprocess = createMockSubprocess()
        subprocesses.push(subprocess)
        return subprocess
      },
      {
        readRunningWslDistros: readRunning,
        historyPath: historyDir,
        wslBridgeBootIdentity: new WslBridgeBootIdentity({
          isRunning: async () => true,
          readBootId,
          noteMayHaveStopped
        })
      }
    )
    dir = harness.dir
    server = harness.server
    adapter = harness.adapter
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
    rmSync(historyDir, { recursive: true, force: true })
  })

  async function spawnBridgePane(): Promise<string> {
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })
    // What a spawn in `\\wsl.localhost\Ubuntu\...` records.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter's protected spawn bookkeeping, which a WSL spawn runs; called here without faking win32.
    const internals = adapter as unknown as {
      noteSpawnWslDistro: (id: string, distro: string, clear: boolean) => void
    }
    internals.noteSpawnWslDistro(id, 'Ubuntu', false)
    return id
  }

  function collectExits(): Exit[] {
    const exits: Exit[] = []
    adapter.onExit((payload) => exits.push(payload))
    return exits
  }

  it('is host loss when its distro is no longer running, so the tab is kept', async () => {
    running = async () => ({ status: 'confirmed', distros: [] })
    const exits = collectExits()
    const id = await spawnBridgePane()
    const clear = vi.spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter's protected clearExitedSessionState, spied to read its history option.
      adapter as unknown as { clearExitedSessionState: (...args: unknown[]) => void },
      'clearExitedSessionState'
    )

    subprocesses[0]!._simulateExit(1)

    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([{ id, code: -1, incarnationId: expect.any(String), hostLost: true }])
    // Ending its history would refuse the cold restore the kept tab needs.
    expect(clear).toHaveBeenCalledWith(id, -1, expect.any(String), { closeHistory: false })
  })

  it("closes a pane's own clean exit at once, with no settle wait or running-list read", async () => {
    // A list that never answers: classifying the exit would hang it.
    running = () => new Promise<WslRunningDistrosRead>(() => {})
    const exits = collectExits()
    const id = await spawnBridgePane()

    subprocesses[0]!._simulateExit(0)

    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([expect.objectContaining({ id, code: 0 })])
    expect(exits[0]).not.toHaveProperty('hostLost')
    expect(readRunning).not.toHaveBeenCalled()
    // Still marked: background reads must settle in case the distro did stop (poweroff, --shutdown).
    expect(noteMayHaveStopped).toHaveBeenCalledWith('Ubuntu')
  })

  it('stays a normal exit while its distro runs on the same boot, so `exit` still closes the tab', async () => {
    const exits = collectExits()
    const id = await spawnBridgePane()

    subprocesses[0]!._simulateExit(1)

    await waitFor(() => exits.length > 0)
    expect(exits[0]).toMatchObject({ id, code: 1, cause: { kind: 'exited', exitCode: 1 } })
    expect(exits[0]).not.toHaveProperty('hostLost')
  })

  // 5e hardening (a): something booted the distro again before the running list answered.
  it('is host loss when the distro runs again under a new boot id', async () => {
    bootIds = ['boot-1', 'boot-2']
    const exits = collectExits()
    const id = await spawnBridgePane()

    subprocesses[0]!._simulateExit(1)

    await waitFor(() => exits.length > 0)
    expect(exits).toEqual([{ id, code: -1, incarnationId: expect.any(String), hostLost: true }])
    expect(readBootId).toHaveBeenCalledTimes(2)
  })

  // #35050 review: a pane opened during another's exit verdict took the old boot's id.
  it("lets a pane opened during another pane's exit verdict close on its own `exit`", async () => {
    bootIds = ['boot-1', 'boot-2']
    let answer: (read: WslRunningDistrosRead) => void = () => {}
    running = () =>
      new Promise((resolve) => {
        answer = resolve
      })
    const exits = collectExits()
    const first = await spawnBridgePane()
    await waitFor(() => readBootId.mock.calls.length === 1)

    subprocesses[0]!._simulateExit(1)
    await waitFor(() => readRunning.mock.calls.length === 1)
    const second = await spawnBridgePane()
    answer({ status: 'confirmed', distros: ['Ubuntu'] })
    await waitFor(() => exits.length === 1)
    expect(exits[0]).toMatchObject({ id: first, code: -1, hostLost: true })

    running = async () => ({ status: 'confirmed', distros: ['Ubuntu'] })
    subprocesses[1]!._simulateExit(1)
    await waitFor(() => exits.length === 2)
    expect(exits[1]).toMatchObject({ id: second, code: 1 })
    expect(exits[1]).not.toHaveProperty('hostLost')
  })

  // awin: a terminate exited each bridge pane with -1, never 0; a user's `exit` gives 0.

  it('stays a normal exit when the running list cannot answer', async () => {
    running = async () => ({ status: 'unavailable' })
    const exits = collectExits()
    const id = await spawnBridgePane()

    subprocesses[0]!._simulateExit(1)

    await waitFor(() => exits.length > 0)
    expect(exits[0]).toMatchObject({ id, code: 1 })
  })
})
