import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { getHistorySessionDirName } from '../../../history/storage/history-paths'
import { HistoryReader } from '../../../history/restoration/history-reader'
import { HistoryFlight } from '../../../history/journal/terminal-history-read-admission'
import { gateReconstruction } from '../../../history/journal/testing/terminal-history-read-fixture'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>> | undefined
const adapters: DaemonPtyAdapter[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const adapter of adapters.splice(0)) {
    await adapter.disconnectOnly()
    adapter.dispose()
  }
  harness?.adapter.dispose()
  await harness?.server.shutdown()
  if (harness) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
  harness = undefined
})

async function startHostHistory(
  spawn: Parameters<typeof startDaemonAdapterHarness>[0] = () => createMockSubprocess()
) {
  harness = await startDaemonAdapterHarness(spawn, {}, { hostHistory: true })
  const options = {
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    historyPath: join(harness.dir, 'history')
  }
  const open = (): DaemonPtyAdapter => {
    const adapter = new DaemonPtyAdapter(options)
    adapters.push(adapter)
    return adapter
  }
  return { open, root: options.historyPath }
}

const claim = {
  digestVersion: 1 as const,
  keyId: 'key',
  identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  agent: 'codex' as const
}
const surface = (terminalHandle: string) => ({
  worktreeId: 'worktree',
  tabId: 'tab',
  leafId: '11111111-1111-4111-8111-111111111111',
  terminalHandle
})

// Real zsh 5.9 bytes: the prompt, `sleep 1` run with bracketed paste toggled, then the next prompt.
const ZSH = readFileSync(
  join(__dirname, '../../../../runtime/__fixtures__/zsh-prompt-runs-command.txt'),
  'utf8'
)
const ZSH_COMMAND_END = ZSH.indexOf('\x1b[?2004l\r\r\n') + '\x1b[?2004l\r\r\n'.length
const LINK = 'https://example.com/fidelity'

async function render(ansi: string, cols: number, rows: number): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(ansi, resolve))
  return terminal
}

/** What a user sees: every row, wrapping, cursor, wide and styled cells, and paste mode. */
function observe(terminal: Terminal) {
  const buffer = terminal.buffer.active
  const lines = Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)!)
  const cell = (row: number, col: number) => lines[row]!.getCell(col)!
  return {
    size: [terminal.cols, terminal.rows],
    rows: lines.map((line) => line.translateToString(true)),
    wrapped: lines.flatMap((line, row) => (line.isWrapped ? [row] : [])),
    cursor: [buffer.cursorX, buffer.baseY + buffer.cursorY],
    wide: [cell(3, 5).getChars(), cell(3, 5).getWidth(), cell(3, 6).getWidth()],
    secondWide: [cell(7, 6).getChars(), cell(7, 6).getWidth()],
    style: [cell(4, 0).isBold() !== 0, cell(4, 0).isFgPalette(), cell(4, 0).getFgColor()],
    plain: [cell(4, 9).isBold() !== 0, cell(4, 9).isFgDefault()],
    bracketedPaste: terminal.modes.bracketedPasteMode
  }
}

describe('host-owned attach replies', () => {
  // N1: a cached or joined adopted attach used to send its reply without the claim result.
  it('reports the adopted claim on cached and joined attaches without killing the agent', async () => {
    const child = createMockSubprocess()
    const { open } = await startHostHistory(() => child)
    const canonical = 'claimed-canonical'
    const created = await open().spawn({
      cols: 80,
      rows: 24,
      sessionId: canonical,
      agentSessionEnsure: { claim, surface: surface('term_first') }
    })
    expect(created.agentSessionEnsure?.disposition).toBe('created')
    child._simulateData('CLAIMED_ROW\r\n')
    const adopt = (handle: string) =>
      open().spawn({
        cols: 80,
        rows: 24,
        sessionId: `requested-${handle}`,
        agentSessionEnsure: { claim, surface: surface(handle) }
      })

    // The first adopt reconstructs and leaves the latest answer; the next one reuses it.
    expect((await adopt('term_cold')).agentSessionEnsure?.disposition).toBe('adopted')
    const cached = await adopt('term_cached')
    // Two adopts of one unchanged cut share a single reconstruction.
    child._simulateData('JOINED_ROW\r\n')
    const joined = await Promise.all([adopt('term_lead'), adopt('term_join')])

    for (const result of [cached, ...joined]) {
      expect(result.id).toBe(canonical)
      expect(result.agentSessionEnsure?.disposition).toBe('adopted')
    }
    expect(joined[1]!.snapshot).toContain('JOINED_ROW')
    expect(child.kill).not.toHaveBeenCalled()
    adapters.at(-1)!.write(canonical, 'still-typing')
    await waitFor(() => child.write.mock.calls.some(([data]) => data === 'still-typing'))
  }, 30_000)

  // A cold attach that cannot fit its reply fails after its provisional token, cleaning up only it.
  it('cleans up an over-long cold attach and attaches normally afterwards', async () => {
    const child = createMockSubprocess()
    const { open } = await startHostHistory(() => child)
    const request = { sessionId: 'cold-oversize', cols: 80, rows: 24, cwd: '/tmp' }
    await open().spawn(request)
    child._simulateData('COLD_ROW\r\n')
    harness!.server.host.setLaunchNote(request.sessionId, {
      arm: {
        launchToken: 'oversize',
        launchConfig: { agentArgs: '', agentEnv: { BIG: '\x1b'.repeat(3 * 1024 * 1024) } }
      }
    })
    const refused = open()
    const refusedData: string[] = []
    refused.onData(({ data }) => refusedData.push(data))
    // ESC expands to six JSON bytes: about 18 MiB on the wire from 3 MiB of text.
    await expect(refused.spawn(request)).rejects.toThrow()

    harness!.server.host.setLaunchNote(request.sessionId, { retire: 'oversize' })
    const viewer = open()
    expect((await viewer.spawn(request)).snapshot).toContain('COLD_ROW')
    child._simulateData('AFTER_CLEANUP\r\n')
    viewer.write(request.sessionId, 'typed-after')
    await waitFor(() => child.write.mock.calls.some(([data]) => data === 'typed-after'))
    expect(refusedData.join('')).not.toContain('AFTER_CLEANUP')
  }, 30_000)

  // NP1: a start whose fork is unknown keeps its conservative disk truth and no hold record.
  it.each([10, 100])(
    'retires %i unknown-outcome start holds and keeps their recovery',
    async (count) => {
      let fail = true
      const { open, root } = await startHostHistory((opts) => {
        if (fail) {
          // The native call threw: whether a process forked is not proven either way.
          opts.onCreationDisposition?.({ kind: 'failed', completion: Promise.resolve() })
          throw new Error('spawn outcome unknown')
        }
        return createMockSubprocess()
      })
      const adapter = open()
      const ids = Array.from({ length: count }, (_, index) => `unknown-start-${index}`)
      for (const sessionId of ids) {
        const dir = join(root, getHistorySessionDirName(sessionId))
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(dir, 'meta.json'),
          JSON.stringify({
            cwd: '/tmp',
            cols: 80,
            rows: 24,
            startedAt: '2026-11-01T10:00:00Z',
            endedAt: '2026-11-01T11:00:00Z',
            exitCode: 0
          })
        )
        await expect(
          adapter.spawn({ sessionId, cols: 80, rows: 24, cwd: '/tmp' })
        ).rejects.toThrow()
      }

      const reader = new HistoryReader(root)
      expect(ids.every((id) => reader.probeRestorableHistory(id).status === 'restorable')).toBe(
        true
      )
      fail = false
      await adapter.spawn({ sessionId: ids[0]!, cols: 80, rows: 24, cwd: '/tmp' })
      expect(reader.probeRestorableHistory(ids[0]!).status).toBe('restorable')
    },
    120_000
  )

  // The live terminal and the journal's reconstruction must agree through reflow both ways.
  it('reconstructs the rows, cells, cursor, mode and link the live terminal shows', async () => {
    const child = createMockSubprocess()
    const { open } = await startHostHistory(() => child)
    const sessionId = 'live-fidelity'
    const owner = open()
    const live = new Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true })
    let streamed = ''
    let painted: Promise<void> = Promise.resolve()
    owner.onData(({ data }) => {
      streamed += data
      painted = painted.then(() => new Promise<void>((resolve) => live.write(data, resolve)))
    })
    await owner.spawn({ sessionId, cols: 80, rows: 24, cwd: '/tmp' })
    const emit = async (data: string): Promise<void> => {
      const expected = streamed.length + data.length
      child._simulateData(data)
      await waitFor(() => streamed.length >= expected)
      await painted
    }
    const resize = async (cols: number, rows: number): Promise<void> => {
      owner.resize(sessionId, cols, rows)
      await waitFor(() =>
        vi.mocked(child.resize).mock.calls.some(([c, r]) => c === cols && r === rows)
      )
      live.resize(cols, rows)
    }

    await emit(ZSH.slice(0, ZSH_COMMAND_END))
    await emit(
      `LONG_A ${'a'.repeat(53)}\r\nLONG_B ${'b'.repeat(53)}\r\nWIDE 漢字テスト end\r\n` +
        `\x1b[1;31mRED_BOLD\x1b[0m plain\r\n\x1b]8;;${LINK}\x1b\\LINK_TEXT\x1b]8;;\x1b\\ after\r\n`
    )
    // Narrowing wraps the long rows; widening joins them and the row written narrow.
    await resize(40, 24)
    await emit(`NARROW_${'n'.repeat(43)}\r\nWIDE2 端末\r\n`)
    await resize(100, 30)
    await emit(ZSH.slice(ZSH_COMMAND_END))

    const window = await owner.getBufferSnapshot(sessionId, { scrollbackRows: 1000 })
    const deep = await owner.getBufferSnapshot(sessionId)
    const reattached = await open().spawn({ sessionId, cols: 100, rows: 30, cwd: '/tmp' })
    const expected = {
      size: [100, 30],
      rows: [
        '% sleep 1',
        `LONG_A ${'a'.repeat(53)}`,
        `LONG_B ${'b'.repeat(53)}`,
        'WIDE 漢字テスト end',
        'RED_BOLD plain',
        'LINK_TEXT after',
        `NARROW_${'n'.repeat(43)}`,
        'WIDE2 端末',
        // zsh writes the space after its prompt; only unwritten cells trim.
        '% ',
        ...Array<string>(21).fill('')
      ],
      wrapped: [],
      cursor: [2, 8],
      wide: ['漢', 2, 0],
      secondWide: ['端', 2],
      style: [true, true, 1],
      plain: [false, true],
      bracketedPaste: true
    }
    const views = {
      live,
      window: await render(`${window!.scrollbackAnsi}${window!.data}`, window!.cols, window!.rows),
      deep: await render(`${deep!.scrollbackAnsi}${deep!.data}`, deep!.cols, deep!.rows),
      reattached: await render(
        reattached.snapshot!,
        reattached.snapshotCols!,
        reattached.snapshotRows!
      )
    }
    for (const [name, view] of Object.entries(views)) {
      expect({ name, ...observe(view) }).toEqual({ name, ...expected })
    }
    const link = [{ row: 5, startCol: 0, endCol: 9, uri: LINK }]
    expect(window!.oscLinks).toEqual(link)
    expect(deep!.oscLinks).toEqual(link)
  }, 30_000)

  // GH1247: an attach past its own history deadline keeps the live terminal for a same-ID Retry.
  // Real time: the attach waits out its existing 5 s internal history deadline.
  it('refuses an attach past its own history deadline as retryable, then attaches the same process', async () => {
    const child = createMockSubprocess()
    let spawned = 0
    const { open } = await startHostHistory(() => {
      spawned += 1
      return child
    })
    const sessionId = 'attach-own-deadline'
    const original = await open().spawn({ sessionId, cols: 80, rows: 24, cwd: '/tmp' })
    child._simulateData('BASE_ROW\r\n')
    const reconstruction = gateReconstruction(
      harness!.server.host.historyJournals!.live(sessionId)!
    )
    const attacher = open()

    await expect(attacher.spawn({ sessionId, cols: 80, rows: 24, cwd: '/tmp' })).rejects.toThrow(
      'terminal_history_unavailable'
    )
    expect(spawned).toBe(1)
    expect(child.kill).not.toHaveBeenCalled()
    reconstruction.open()
    const attached = await attacher.spawn({ sessionId, cols: 80, rows: 24, cwd: '/tmp' })
    expect(attached.incarnationId).toBe(original.incarnationId)
    expect(spawned).toBe(1)
    attacher.write(sessionId, 'typed-after-retry')
    await waitFor(() => child.write.mock.calls.some(([data]) => data === 'typed-after-retry'))
  }, 30_000)

  // The joined image is for an older cut; the attach retries at the new one before detaching.
  it('retries a joined attach whose live cut moved, with its old viewer kept until then', async () => {
    const child = createMockSubprocess()
    const { open } = await startHostHistory(() => child)
    const sessionId = 'joined-retry'
    const viewer = open()
    let viewerData = ''
    viewer.onData(({ data }) => (viewerData += data))
    await viewer.spawn({ sessionId, cols: 80, rows: 24, cwd: '/tmp' })
    child._simulateData('BASE_ROW\r\n')
    const reconstruction = gateReconstruction(
      harness!.server.host.historyJournals!.live(sessionId)!
    )
    const joins = vi.spyOn(HistoryFlight.prototype, 'join')
    // A deep read leads the reconstruction and the reattach joins it at the same cut.
    const leader = viewer.getBufferSnapshot(sessionId)
    await waitFor(() => reconstruction.calls.mock.calls.length > 0)
    const attacher = open()
    let attachedData = ''
    attacher.onData(({ data }) => (attachedData += data))
    let settled = false
    const attaching = attacher
      .spawn({ sessionId, cols: 90, rows: 24, cwd: '/tmp' })
      .finally(() => (settled = true))
    await waitFor(() => joins.mock.calls.length > 1)

    child._simulateData('DURING_ROW\r\n')
    viewer.resize(sessionId, 90, 24)
    await waitFor(() => vi.mocked(child.resize).mock.calls.some(([c, r]) => c === 90 && r === 24))
    await waitFor(() => viewerData.includes('DURING_ROW'))
    viewer.write(sessionId, 'typed-by-viewer')
    await waitFor(() => child.write.mock.calls.some(([data]) => data === 'typed-by-viewer'))
    // The stale image completes; the retry's own reconstruction is held while output continues.
    reconstruction.open()
    reconstruction.close()
    await waitFor(() => reconstruction.calls.mock.calls.length > 1 || settled)
    child._simulateData('RETRY_ROW\r\n')
    reconstruction.open()
    const attached = await attaching
    await leader

    expect([attached.snapshotCols, attached.snapshotRows]).toEqual([90, 24])
    const screen = await render(attached.snapshot!, 90, 24)
    const rows = observe(screen).rows
    expect(rows.slice(0, 3)).toEqual(['BASE_ROW', 'DURING_ROW', ''])
    await waitFor(() => attachedData.includes('RETRY_ROW'))
    child._simulateData('AFTER_ROW\r\n')
    await waitFor(() => attachedData.includes('AFTER_ROW'))
    expect(attachedData).toBe('RETRY_ROW\r\nAFTER_ROW\r\n')
    expect(viewerData).not.toContain('AFTER_ROW')
    attacher.write(sessionId, 'typed-after-retry')
    await waitFor(() => child.write.mock.calls.some(([data]) => data === 'typed-after-retry'))
    expect(child.write.mock.calls.filter(([data]) => data === 'typed-after-retry')).toHaveLength(1)
  }, 30_000)
})
