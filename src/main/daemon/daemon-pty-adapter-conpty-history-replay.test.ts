import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFileSync, rmSync } from 'node:fs'
import { Terminal } from '@xterm/headless'
import { HistoryReader } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from './daemon-health'
import type * as DaemonTccAttributionModule from './daemon-tcc-attribution'
import type * as DaemonHistoryReplayPtyModule from './daemon-history-replay-pty'
import type * as ConptyReflowViewportModule from './conpty-reflow-viewport'
import type * as DaemonDurableHistorySnapshotModule from './daemon-durable-history-snapshot'

const { getMacDaemonSystemResolverHealthMock, getMacDaemonTccAttributionHealthMock } = vi.hoisted(
  () => ({
    getMacDaemonSystemResolverHealthMock: vi.fn(
      async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
    ),
    getMacDaemonTccAttributionHealthMock: vi.fn(
      async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
    )
  })
)

// An older daemon: its hello reports no resize model and its live emulators resize as xterm does.
const olderDaemon = vi.hoisted((): { hosting: boolean; rebuildModels: unknown[] } => ({
  hosting: false,
  rebuildModels: []
}))
vi.mock('./daemon-durable-history-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonDurableHistorySnapshotModule>()
  return {
    ...actual,
    buildDurableCheckpointSnapshot: (
      opts: Parameters<typeof actual.buildDurableCheckpointSnapshot>[0]
    ) => {
      olderDaemon.rebuildModels.push(opts.resizeModel)
      return actual.buildDurableCheckpointSnapshot(opts)
    }
  }
})
vi.mock('./daemon-history-replay-pty', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHistoryReplayPtyModule>()
  return {
    ...actual,
    daemonHelloResizeModel: () => (olderDaemon.hosting ? {} : actual.daemonHelloResizeModel())
  }
})
vi.mock('./conpty-reflow-viewport', async (importOriginal) => {
  const actual = await importOriginal<typeof ConptyReflowViewportModule>()
  return {
    ...actual,
    resizeLikeOwnPty: (...args: Parameters<typeof actual.resizeLikeOwnPty>) =>
      olderDaemon.hosting ? args[0].resize(args[1], args[2]) : actual.resizeLikeOwnPty(...args)
  }
})

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('./daemon-tcc-attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonTccAttributionModule>()
  return {
    ...actual,
    getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock
  }
})

async function conptyRepaintAfterResize(
  output: string,
  [fromCols, fromRows]: [number, number],
  [toCols, toRows]: [number, number]
): Promise<string> {
  const conpty = new Terminal({
    cols: fromCols,
    rows: fromRows,
    scrollback: 0,
    allowProposedApi: true
  })
  await new Promise<void>((resolve) => conpty.write(output, resolve))
  conpty.resize(toCols, toRows)
  const screen: string[] = []
  for (let row = 0; row < toRows; row++) {
    screen.push(`${conpty.buffer.active.getLine(row)?.translateToString(true) ?? ''}\x1b[K`)
  }
  const cursor = `\x1b[${conpty.buffer.active.cursorY + 1};${conpty.buffer.active.cursorX + 1}H`
  conpty.dispose()
  return `\x1b[H${screen.join('\r\n')}${cursor}`
}

/** Drives the adapter's own periodic save, which has no public trigger. */
class SavingDaemonPtyAdapter extends DaemonPtyAdapter {
  savePeriodically(sessionIds: string[]): Promise<unknown> {
    return this.checkpointSessions(sessionIds, { final: false })
  }

  /** A full checkpoint, which rebuilds durable history around the live snapshot. */
  saveFinally(sessionIds: string[]): Promise<unknown> {
    return this.checkpointSessions(sessionIds, { final: true })
  }

  /** Drops the daemon connection while the next checkpoint commits. */
  disconnectDuringNextCommit(): void {
    const manager = this.historyManager
    if (!manager) {
      throw new Error('no history')
    }
    const commit = manager.checkpoint.bind(manager)
    manager.checkpoint = (...args) => {
      manager.checkpoint = commit
      this.client.disconnect()
      return commit(...args)
    }
  }

  reconnect(): Promise<void> {
    return this.client.ensureConnected()
  }

  /** A fresh hello, as after the daemon was replaced. */
  async reconnectToNewDaemon(): Promise<void> {
    this.client.disconnect()
    await this.client.ensureConnected()
  }
}

describe('daemon history of a ConPTY session through a resize', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockReset()
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })
  /** Records a ConPTY session through one resize, then restores it from checkpoint and log. */
  async function restoredLabels(opts: {
    from: [number, number]
    to: [number, number]
    /** New main recording a session an older daemon hosts. */
    olderDaemon?: boolean
  }): Promise<string[]> {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    olderDaemon.hosting = opts.olderDaemon === true
    olderDaemon.rebuildModels = []
    try {
      const historyDir = join(dir, 'history')
      const sessionId = `wt-1::/project@@resize${opts.from[0]}to${opts.to[0]}`
      const history = new SavingDaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      await history.spawn({ cols: opts.from[0], rows: opts.from[1], cwd: '/project', sessionId })
      await history.savePeriodically([sessionId])
      // Rows of 70 columns wrap at 40 and fit at 120, so the resize moves rows through scrollback.
      const output = `${Array.from({ length: 30 }, (_, i) => `${'x'.repeat(70)} L${i}`).join('\r\n')}\r\n$ `
      lastSubprocess._simulateData(output)
      await history.savePeriodically([sessionId])
      history.resize(sessionId, opts.to[0], opts.to[1])
      // ConPTY keeps no scrollback: it repaints from the top only the screen it still holds.
      lastSubprocess._simulateData(await conptyRepaintAfterResize(output, opts.from, opts.to))
      await history.savePeriodically([sessionId])
      await history.saveFinally([sessionId])
      history.dispose()
      const metaPath = join(historyDir, getHistorySessionDirName(sessionId), 'meta.json')
      // Main stamps, and rebuilds durable history with, the hosting daemon's model, never its own.
      const hostingModel = opts.olderDaemon ? null : 'conpty-viewport-v1'
      expect(JSON.parse(readFileSync(metaPath, 'utf8')).resizeModel).toBe(hostingModel ?? undefined)
      expect(olderDaemon.rebuildModels.length).toBeGreaterThan(0)
      expect(new Set(olderDaemon.rebuildModels)).toEqual(new Set([hostingModel]))

      const restored = await new HistoryReader(historyDir).detectColdRestore(sessionId, {
        ignoreCleanEnd: true
      })
      expect(restored).not.toBeNull()
      const terminal = new Terminal({
        cols: opts.to[0],
        rows: opts.to[1],
        scrollback: 5000,
        allowProposedApi: true
      })
      await new Promise<void>((resolve) => terminal.write(restored!.snapshotAnsi, resolve))
      const labels: string[] = []
      for (let i = 0; i < terminal.buffer.active.length; i++) {
        const match = /L(\d+)$/.exec(
          terminal.buffer.active.getLine(i)?.translateToString(true) ?? ''
        )
        if (match) {
          labels.push(`L${match[1]}`)
        }
      }
      terminal.dispose()
      return labels
    } finally {
      olderDaemon.hosting = false
      if (original) {
        Object.defineProperty(process, 'platform', original)
      }
    }
  }

  const EVERY_ROW_ONCE = Array.from({ length: 30 }, (_, i) => `L${i}`)

  // Sleep, Wake, quit and relaunch, then Sleep put the new prompt on the old one.
  it('restores a widened ConPTY session from its checkpoint and log with no lost or doubled rows', async () => {
    expect(await restoredLabels({ from: [40, 10], to: [120, 10] })).toEqual(EVERY_ROW_ONCE)
  })

  it('restores a narrowed ConPTY session from its checkpoint and log with no lost or doubled rows', async () => {
    expect(await restoredLabels({ from: [120, 10], to: [40, 10] })).toEqual(EVERY_ROW_ONCE)
  })

  // New main after an update, with sessions still hosted by the older daemon.
  it("records an older daemon's session with xterm's model, as that daemon's live screen has it", async () => {
    // xterm's model pulls four rows back out of scrollback, and ConPTY's repaint overwrites them.
    const overwritten = ['L21', 'L22', 'L23', 'L24']
    expect(await restoredLabels({ from: [40, 10], to: [120, 10], olderDaemon: true })).toEqual(
      EVERY_ROW_ONCE.filter((label) => !overwritten.includes(label))
    )
  })

  function resizeStamp(historyDir: string, sessionId: string): unknown {
    const metaPath = join(historyDir, getHistorySessionDirName(sessionId), 'meta.json')
    return JSON.parse(readFileSync(metaPath, 'utf8')).resizeModel
  }

  it('keeps the stamp through a disconnect mid-commit: unknown is not an older daemon', async () => {
    const historyDir = join(dir, 'history')
    const sessionId = 'wt-1::/project@@disconnect1'
    const history = new SavingDaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    await history.spawn({ cols: 40, rows: 10, cwd: '/project', sessionId })
    lastSubprocess._simulateData('$ ')
    history.disconnectDuringNextCommit()
    await history.saveFinally([sessionId])
    expect(resizeStamp(historyDir, sessionId)).toBe('conpty-viewport-v1')
    await history.reconnect()
    lastSubprocess._simulateData('echo hi\r\nhi\r\n$ ')
    await history.saveFinally([sessionId])
    expect(resizeStamp(historyDir, sessionId)).toBe('conpty-viewport-v1')
    history.dispose()
  })

  // Window 1: a Sleep cache wake on a newer daemon restamps with the first checkpoint (#34060).
  it("restamps a session woken from the Sleep cache onto a newer daemon with that daemon's model", async () => {
    const historyDir = join(dir, 'history')
    const sessionId = 'wt-1::/project@@wake-upgrade1'
    olderDaemon.hosting = true
    try {
      const history = new SavingDaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      await history.spawn({ cols: 40, rows: 10, cwd: '/project', sessionId })
      lastSubprocess._simulateData('$ echo before\r\nbefore\r\n$ ')
      await history.shutdown(sessionId, { immediate: true, keepHistory: true })
      expect(resizeStamp(historyDir, sessionId)).toBeUndefined()
      // The daemon is replaced by a newer one before the wake.
      olderDaemon.hosting = false
      await history.reconnectToNewDaemon()
      await history.spawn({ cols: 40, rows: 10, cwd: '/project', sessionId })
      history.ackColdRestore(sessionId)
      lastSubprocess._simulateData('$ echo after\r\nafter\r\n$ ')
      await history.savePeriodically([sessionId])
      expect(resizeStamp(historyDir, sessionId)).toBe('conpty-viewport-v1')
      history.dispose()
    } finally {
      olderDaemon.hosting = false
    }
  })
})
