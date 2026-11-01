// verify-15a 5e: `wsl --terminate` exited a live bridge pane with code 1, which closed its tab.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { setActiveSink } from '../observability/tracer'
import { HistoryManager } from './history-manager'
import { WslBridgeBootIdentity } from './daemon-wsl-bridge-boot-identity'
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

  it('marks a non-zero exit as a possible stop before classifying it', async () => {
    running = async () => ({ status: 'confirmed', distros: [] })
    const exits = collectExits()
    await spawnBridgePane()

    subprocesses[0]!._simulateExit(1)

    await waitFor(() => exits.length > 0)
    expect(noteMayHaveStopped).toHaveBeenCalledWith('Ubuntu')
  })

  it('logs what the running list said, so a run can tell host loss from a raced reboot', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const spans: unknown[] = []
    setActiveSink({
      push: (span) => spans.push(span),
      flush: () => {},
      close: () => {}
    })
    onTestFinished(() => setActiveSink(null))
    for (const [distros, verdict] of [
      [[], 'lost'],
      [['Ubuntu'], 'running']
    ] as const) {
      running = async () => ({ status: 'confirmed', distros: [...distros] })
      const exits = collectExits()
      await spawnBridgePane()
      subprocesses.at(-1)!._simulateExit(1)
      await waitFor(() => exits.length > 0)
      expect(info).toHaveBeenLastCalledWith(
        expect.stringMatching(
          new RegExp(
            `^\\[pty\\] WSL bridge exit: ${verdict} \\(distro Ubuntu, code 1, probe \\d+ms\\)$`
          )
        )
      )
      // Kept in the local trace too: a packaged build keeps no console (verify-18).
      expect(spans.at(-1)).toMatchObject({
        name: 'wsl.bridge-exit',
        attributes: { verdict, code: 1 }
      })
      expect(JSON.stringify(spans.at(-1))).not.toContain('Ubuntu')
    }
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
  it('reads no boot id for a clean exit, which stays an exit even across a reboot', async () => {
    bootIds = ['boot-1', 'boot-2']
    const exits = collectExits()
    const id = await spawnBridgePane()
    await waitFor(() => readBootId.mock.calls.length === 1)

    subprocesses[0]!._simulateExit(0)

    await waitFor(() => exits.length > 0)
    expect(exits[0]).toMatchObject({ id, code: 0 })
    expect(exits[0]).not.toHaveProperty('hostLost')
    expect(readBootId).toHaveBeenCalledOnce()
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
