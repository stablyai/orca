// verify-15a 5e: `wsl --terminate` exited a live bridge pane with code 1, which closed its tab.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { HistoryManager } from './history-manager'
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

  beforeEach(async () => {
    historyDir = mkdtempSync(join(tmpdir(), 'orca-distro-loss-history-'))
    subprocesses = []
    running = async () => ({ status: 'confirmed', distros: ['Ubuntu'] })
    readRunning.mockClear()
    const harness = await startDaemonAdapterHarness(
      () => {
        const subprocess = createMockSubprocess()
        subprocesses.push(subprocess)
        return subprocess
      },
      {
        readRunningWslDistros: readRunning,
        historyPath: historyDir
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter's protected map, which a WSL spawn fills; set here without faking win32.
    const internals = adapter as unknown as { wslDistrosBySessionId: Map<string, string> }
    internals.wslDistrosBySessionId.set(id, 'Ubuntu')
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

  it('stays a normal exit while its distro runs, so `exit` still closes the tab', async () => {
    const exits = collectExits()
    const id = await spawnBridgePane()

    subprocesses[0]!._simulateExit(1)

    await waitFor(() => exits.length > 0)
    expect(exits[0]).toMatchObject({ id, code: 1, cause: { kind: 'exited', exitCode: 1 } })
    expect(exits[0]).not.toHaveProperty('hostLost')
  })

  it('stays a normal exit when the running list cannot answer', async () => {
    running = async () => ({ status: 'unavailable' })
    const exits = collectExits()
    const id = await spawnBridgePane()

    subprocesses[0]!._simulateExit(1)

    await waitFor(() => exits.length > 0)
    expect(exits[0]).toMatchObject({ id, code: 1 })
  })

  it('classifies many panes a terminate exits at once from one answer', async () => {
    let answer: (read: WslRunningDistrosRead) => void = () => {}
    const pending = new Promise<WslRunningDistrosRead>((resolve) => {
      answer = resolve
    })
    running = () => pending
    const exits = collectExits()
    await spawnBridgePane()
    await spawnBridgePane()
    await spawnBridgePane()

    for (const subprocess of subprocesses) {
      subprocess._simulateExit(1)
    }
    await waitFor(() => readRunning.mock.calls.length === 3)
    answer({ status: 'confirmed', distros: [] })

    await waitFor(() => exits.length === 3)
    expect(exits.map(({ code }) => code)).toEqual([-1, -1, -1])
  })

  it('never asks about a native pane', async () => {
    const exits = collectExits()
    const { id } = await adapter.spawn({ cols: 80, rows: 24 })

    subprocesses[0]!._simulateExit(1)

    await waitFor(() => exits.length > 0)
    expect(exits[0]).toMatchObject({ id, code: 1 })
    expect(readRunning).not.toHaveBeenCalled()
  })

  it('drops a kept tab’s history when the user later closes it, though its session is gone', async () => {
    running = async () => ({ status: 'confirmed', distros: [] })
    const exits = collectExits()
    const id = await spawnBridgePane()
    subprocesses[0]!._simulateExit(1)
    await waitFor(() => exits.length > 0)
    const removeSession = vi.spyOn(HistoryManager.prototype, 'removeSession')

    await expect(adapter.shutdown(id, { immediate: true })).resolves.toBeUndefined()
    expect(removeSession).toHaveBeenCalledWith(id)
  })

  it('never removes the history of a session it did not lose: another daemon may still run it', async () => {
    const removeSession = vi.spyOn(HistoryManager.prototype, 'removeSession')

    await expect(adapter.shutdown('legacy-daemon-session', { immediate: true })).rejects.toThrow(
      'Session not found'
    )
    expect(removeSession).not.toHaveBeenCalled()
  })

  it('forgets a host-loss session once it is spawned again', async () => {
    running = async () => ({ status: 'confirmed', distros: [] })
    const exits = collectExits()
    const id = await spawnBridgePane()
    subprocesses[0]!._simulateExit(1)
    await waitFor(() => exits.length > 0)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter's protected host-loss set, read to prove a respawn clears it.
    const lost = (adapter as unknown as { hostLossSessionIds: Set<string> }).hostLossSessionIds
    expect(lost.has(id)).toBe(true)

    await adapter.spawn({ cols: 80, rows: 24, sessionId: id })
    expect(lost.has(id)).toBe(false)
  })
})
