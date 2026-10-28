// A WSL bridge pane lost with its distro keeps its tab and unended history; after a relaunch no
// daemon runs its id, so closing the tab must still end that history, and only then.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { DaemonServer } from './daemon-server'
import type * as NewerHoldModule from './daemon-newer-protocol-hold'
import { getDaemonPidPath, serializeDaemonPidFile } from './daemon-spawner'
import { getHistorySessionDirName } from './history-paths'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

const { newerHold } = vi.hoisted(() => ({ newerHold: { held: false } }))
vi.mock('./daemon-newer-protocol-hold', async (importOriginal) => ({
  ...(await importOriginal<typeof NewerHoldModule>()),
  isHoldingForNewerProtocolDaemon: () => newerHold.held
}))

describe('closing a kept host-loss tab after a relaunch', () => {
  let dir: string
  let historyDir: string
  let runtimeDir: string
  let server: DaemonServer
  let socketPath: string
  let tokenPath: string
  let lostId: string
  let original: DaemonPtyAdapter
  let lastSubprocess: () => ReturnType<typeof createMockSubprocess>
  const opened: DaemonPtyAdapter[] = []

  beforeEach(async () => {
    newerHold.held = false
    historyDir = mkdtempSync(join(tmpdir(), 'orca-lost-close-history-'))
    runtimeDir = mkdtempSync(join(tmpdir(), 'orca-lost-close-runtime-'))
    let subprocess: ReturnType<typeof createMockSubprocess> | undefined
    const harness = await startDaemonAdapterHarness(
      () => {
        subprocess = createMockSubprocess()
        return subprocess
      },
      {
        readRunningWslDistros: async () => ({ status: 'confirmed', distros: [] }),
        historyPath: historyDir
      }
    )
    ;({ dir, server, socketPath, tokenPath } = harness)
    lastSubprocess = () => subprocess!
    original = harness.adapter
    opened.push(harness.adapter)
    const exited: string[] = []
    harness.adapter.onExit(({ id }) => exited.push(id))
    lostId = (await harness.adapter.spawn({ cols: 80, rows: 24 })).id
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter's protected map, which a WSL spawn fills; set here without faking win32.
    const internals = harness.adapter as unknown as { wslDistrosBySessionId: Map<string, string> }
    internals.wslDistrosBySessionId.set(lostId, 'Ubuntu')
    subprocess!._simulateExit(1)
    await waitFor(() => exited.length > 0)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const adapter of opened.splice(0)) {
      adapter.dispose()
    }
    await server?.shutdown()
    for (const path of [dir, historyDir, runtimeDir]) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  // The relaunched app's adapters remember nothing of the loss.
  function relaunchedAdapter(protocolVersion?: number): DaemonPtyAdapter {
    const adapter = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      historyPath: historyDir,
      runtimeDir,
      ...(protocolVersion ? { protocolVersion } : {})
    })
    opened.push(adapter)
    return adapter
  }

  function routerWithLegacyListing(listed: boolean | null): DaemonPtyRouter {
    const legacy = relaunchedAdapter(51)
    vi.spyOn(legacy, 'listsSession').mockResolvedValue(listed)
    return new DaemonPtyRouter({ current: relaunchedAdapter(), legacy: [legacy] })
  }

  const historyKept = () => existsSync(join(historyDir, getHistorySessionDirName(lostId)))
  const close = (provider: { shutdown: DaemonPtyAdapter['shutdown'] }, id = lostId) =>
    provider.shutdown(id, { immediate: true })

  it('starts from history left unended, as a cold restore needs', () => {
    expect(relaunchedAdapter().hasRestorableHistory(lostId)).toBe(true)
  })

  it('ends the history of a session no daemon lists', async () => {
    await expect(close(relaunchedAdapter())).resolves.toBeUndefined()
    expect(historyKept()).toBe(false)
  })

  it('keeps the history while another daemon lists the id', async () => {
    await expect(close(routerWithLegacyListing(true))).rejects.toThrow('Session not found')
    expect(historyKept()).toBe(true)
  })

  it('keeps the history when a daemon cannot say', async () => {
    await expect(close(routerWithLegacyListing(null))).rejects.toThrow('Session not found')
    expect(historyKept()).toBe(true)
  })

  it('keeps the history while an older daemon it could not reach may be alive', async () => {
    writeFileSync(
      getDaemonPidPath(runtimeDir, 50),
      serializeDaemonPidFile({ pid: process.pid, startedAtMs: Date.parse('2026-01-01T00:00:00Z') })
    )
    await expect(close(relaunchedAdapter())).rejects.toThrow('Session not found')
    expect(historyKept()).toBe(true)
  })

  it('keeps the history while a newer daemon is held', async () => {
    newerHold.held = true
    await expect(close(relaunchedAdapter())).rejects.toThrow('Session not found')
    expect(historyKept()).toBe(true)
  })

  it('holds a spawn of the same id until the close has decided, in one lock', async () => {
    const adapter = relaunchedAdapter()
    let answer!: (listed: boolean) => void
    vi.spyOn(adapter, 'listsSession').mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve
      })
    )
    const closing = close(adapter)
    await vi.waitFor(() => expect(adapter.listsSession).toHaveBeenCalled())
    const spawning = adapter.spawn({ cols: 80, rows: 24, sessionId: lostId })
    const spawned = vi.fn()
    void spawning.then(spawned, spawned)
    // A spawn that slipped in here would make the close find a live session.
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawned).not.toHaveBeenCalled()
    answer(false)
    await expect(closing).resolves.toBeUndefined()
    // The closed id is tombstoned, so the queued spawn cannot revive its history.
    await expect(spawning).rejects.toThrow()
    expect(historyKept()).toBe(false)
  })

  it('never connects a daemon just to ask whether it lists the id', async () => {
    const unconnected = relaunchedAdapter()
    const connect = vi.spyOn(DaemonClient.prototype, 'ensureConnected')
    const connectWithin = vi.spyOn(DaemonClient.prototype, 'ensureConnectedWithin')
    await expect(unconnected.listsSession(lostId)).resolves.toBeNull()
    expect(connect).not.toHaveBeenCalled()
    expect(connectWithin).not.toHaveBeenCalled()
  })

  // Wider than host loss: any tab with unended history and no session, e.g. a slept one.
  async function sleptId(): Promise<string> {
    const { id } = await original.spawn({ cols: 80, rows: 24 })
    lastSubprocess()._simulateData('user@host:~$ echo slept\r\nslept\r\nuser@host:~$ ')
    await original.shutdown(id, { immediate: true, keepHistory: true })
    return id
  }

  it('ends a slept tab’s history when it is closed without waking', async () => {
    const id = await sleptId()
    expect(relaunchedAdapter().hasRestorableHistory(id)).toBe(true)
    await expect(close(relaunchedAdapter(), id)).resolves.toBeUndefined()
    expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(false)
  })

  it('keeps a slept tab’s history while another daemon lists its session', async () => {
    const id = await sleptId()
    await expect(close(routerWithLegacyListing(true), id)).rejects.toThrow('Session not found')
    expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(true)
  })

  it('still refuses an id with no unended history', async () => {
    await expect(close(relaunchedAdapter(), 'never-restorable')).rejects.toThrow(
      'Session not found'
    )
  })
})
