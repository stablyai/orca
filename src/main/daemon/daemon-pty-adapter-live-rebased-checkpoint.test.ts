import './mock-descendant-sweep'
/* Adapter-level coverage for checkpoints rebased on the live daemon snapshot. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { DAEMON_RESTORE_SCROLLBACK_ROWS } from './daemon-restore-scrollback-depth'
import { DAEMON_SESSION_SCROLLBACK_ROWS } from './daemon-session-scrollback-window'
import { HeadlessEmulator } from './headless-emulator'
import { HistoryManager } from './history-manager'
import { getHistorySessionDirName } from './history-paths'
import { HistoryReader } from './history-reader'
import { readTerminalHistoryCheckpoint } from './terminal-history-checkpoint-reader'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

const DEAD_TUI_MODES = ['\x1b[?1049h', '\x1b[?1003h', '\x1b[?1006h']

function numberedLines(from: number, to: number, prefix = 'LINE'): string {
  let output = ''
  for (let index = from; index <= to; index += 1) {
    output += `${prefix}_${String(index).padStart(5, '0')}\r\n`
  }
  return output
}

function expectNoDeadTuiModes(ansi: string): void {
  for (const sequence of DEAD_TUI_MODES) {
    expect(ansi).not.toContain(sequence)
  }
}

describe('DaemonPtyAdapter checkpoints rebased on live', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let historyDir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let historyAdapter: DaemonPtyAdapter | undefined
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
    historyDir = join(dir, 'history')
  })

  afterEach(async () => {
    historyAdapter?.dispose()
    historyAdapter = undefined
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('heals a poisoned checkpoint for getBufferSnapshot, disk and a relaunch reattach', async () => {
    const sessionId = 'poisoned-dead-tui'
    const dead = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 5_000 })
    try {
      expect(dead.writeSync(numberedLines(1, 40))).toBe(true)
      expect(dead.writeSync('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[HDEAD_TUI_FRAME')).toBe(true)
      const seedManager = new HistoryManager(historyDir)
      await seedManager.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
      expect(await seedManager.checkpoint(sessionId, dead.getSnapshot())).toBe('committed')
    } finally {
      dead.dispose()
    }

    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const spawned = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId, cwd: '/tmp' })
    expect(spawned.coldRestore).toBeDefined()

    const buffer = await historyAdapter.getBufferSnapshot(spawned.id)
    expect(buffer).not.toBeNull()
    expect(buffer?.alternateScreen).toBe(false)
    expectNoDeadTuiModes(buffer?.data ?? '')
    expect(`${buffer?.scrollbackAnsi ?? ''}${buffer?.data ?? ''}`).toContain('LINE_00001')

    const checkpoint = await readTerminalHistoryCheckpoint(
      join(historyDir, getHistorySessionDirName(sessionId), 'checkpoint.json')
    )
    if (checkpoint.status !== 'readable') {
      throw new Error(`checkpoint unreadable: ${checkpoint.status}`)
    }
    expect(checkpoint.checkpoint.modes.alternateScreen).toBe(false)
    expect(checkpoint.checkpoint.modes.mouseTracking).toBe(false)
    expectNoDeadTuiModes(checkpoint.checkpoint.rehydrateSequences)
    expectNoDeadTuiModes(checkpoint.checkpoint.snapshotAnsi)

    await historyAdapter.disconnectOnly()
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const reattach = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId, cwd: '/tmp' })
    expect(reattach.isReattach).toBe(true)
    expect(reattach.isAlternateScreen).toBe(false)
    expectNoDeadTuiModes(reattach.snapshot ?? '')
    expect(reattach.snapshot).toContain('LINE_00001')
  })

  it.each([
    { label: '80x40 normal base', cols: 80, rows: 40, altBase: false },
    { label: '100x30 normal base', cols: 100, rows: 30, altBase: false },
    { label: '80x40 alt-screen base', cols: 80, rows: 40, altBase: true },
    { label: '80x24 alt-screen base', cols: 80, rows: 24, altBase: true }
  ])('keeps a gapless seam after a $label cold restore from 80x24', async (size) => {
    const sessionId = `cold-restore-${size.cols}x${size.rows}-${size.altBase ? 'alt' : 'normal'}`
    const dead = new HeadlessEmulator({ cols: 80, rows: 24, scrollback: 5_000 })
    try {
      expect(dead.writeSync(numberedLines(1, 6_000))).toBe(true)
      if (size.altBase) {
        expect(dead.writeSync('\x1b[?1049h\x1b[?1003h\x1b[HDEAD_TUI_FRAME')).toBe(true)
      }
      const seedManager = new HistoryManager(historyDir)
      await seedManager.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
      expect(await seedManager.checkpoint(sessionId, dead.getSnapshot())).toBe('committed')
    } finally {
      dead.dispose()
    }

    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const spawned = await historyAdapter.spawn({
      cols: size.cols,
      rows: size.rows,
      sessionId,
      cwd: '/tmp'
    })
    expect(spawned.coldRestore).toBeDefined()
    historyAdapter.resize(spawned.id, size.cols, size.rows)
    lastSubprocess._simulateData(numberedLines(1, 30, 'NEW'))
    // A hidden pane's getBufferSnapshot is what folds and persists the first rebased checkpoint.
    const snapshot = await historyAdapter.getBufferSnapshot(spawned.id)

    const replayed = new HeadlessEmulator({ cols: size.cols, rows: size.rows, scrollback: 20_000 })
    try {
      expect(replayed.writeSync(`${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`)).toBe(
        true
      )
      const rows = replayed.getBufferTailLines(Number.MAX_SAFE_INTEGER)
      const ids = rows.flatMap((row) => {
        const match = /^LINE_(\d{5})$/.exec(row.trimEnd())
        return match ? [Number(match[1])] : []
      })
      expect(ids.at(-1)).toBe(6_000)
      expect(ids.every((id, index) => index === 0 || id === ids[index - 1] + 1)).toBe(true)
      expect(ids.length).toBeGreaterThan(4_900)
      expect(rows.filter((row) => row.startsWith('NEW_'))).toHaveLength(30)
    } finally {
      replayed.dispose()
    }
  })

  it('bounds a rebased remount snapshot to the requested scrollback rows', async () => {
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const { id } = await historyAdapter.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'bounded-rebase',
      cwd: '/tmp'
    })
    lastSubprocess._simulateData(numberedLines(1, 4_000))
    // Commits the deep rebased checkpoint the bounded read then replays.
    expect(await historyAdapter.getBufferSnapshot(id)).not.toBeNull()

    const snapshot = await historyAdapter.getBufferSnapshot(id, { scrollbackRows: 2_000 })
    const text = `${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data ?? ''}`
    // 2000 scrollback + 24 screen rows, the last of which is the blank cursor row.
    const oldest = 4_000 - (2_000 + 24 - 2)
    expect(text).toContain('LINE_04000')
    expect(text).toContain(`LINE_0${oldest}`)
    expect(text).not.toContain(`LINE_0${oldest - 1}`)
  })

  it('persists held teardown bytes once, from the drained records', async () => {
    const sessionId = 'held-tail'
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const manager = historyAdapter.getHistoryManager()!
    await manager.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
    const base = numberedLines(1, 3_000)
    const marker = '\x1b]777;orca-shell-ready'
    // Session.prepareForFinalSnapshot emits held bytes before the take, so the take repeats them.
    const drained = `${numberedLines(3_001, 3_100)}HELD_TAIL${marker}`
    const disk = new HeadlessEmulator({
      cols: 80,
      rows: 24,
      scrollback: DAEMON_RESTORE_SCROLLBACK_ROWS
    })
    const live = new HeadlessEmulator({
      cols: 80,
      rows: 24,
      scrollback: DAEMON_SESSION_SCROLLBACK_ROWS
    })
    try {
      expect(disk.writeSync(base)).toBe(true)
      expect(await manager.checkpoint(sessionId, disk.getSnapshot())).toBe('committed')
      expect(live.writeSync(base + drained)).toBe(true)
      const liveSnapshot = { ...live.getSnapshot(), outputSequence: 99 }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a teardown checkpoint only calls client.request and the history manager/reader, all real or faked here.
      const internals = historyAdapter as unknown as {
        client: { request: ReturnType<typeof vi.fn>; disconnect: () => void }
        checkpointSessions(
          sessionIds: Iterable<string>,
          opts?: { final?: boolean; teardown?: boolean }
        ): Promise<Set<string>>
      }
      internals.client = {
        request: vi.fn(async () => ({
          records: [{ kind: 'output', data: marker }],
          drainedRecords: [{ kind: 'output', data: drained }],
          seq: 2,
          overflowed: false,
          snapshot: liveSnapshot
        })),
        disconnect: () => {}
      }

      const append = vi.spyOn(manager, 'appendIncrements')

      await expect(
        internals.checkpointSessions([sessionId], { final: true, teardown: true })
      ).resolves.toEqual(new Set([sessionId]))
      expect(append).not.toHaveBeenCalled()

      const restore = await new HistoryReader(historyDir).detectColdRestore(sessionId, {
        ignoreCleanEnd: true
      })
      expect(restore?.modes.alternateScreen).toBe(false)
      const text = restore?.snapshotAnsi ?? ''
      expect(text.split('HELD_TAIL')).toHaveLength(2)
      expect(restore?.pendingEscapeTailAnsi).toBe(marker)
      expect(restore?.pendingOutputSeq).toBe(2)
      expect(text).toContain('LINE_00001')
      expect(text).toContain('LINE_03100')
      expect(text.split('LINE_02000')).toHaveLength(2)
    } finally {
      disk.dispose()
      live.dispose()
    }
  })
})
