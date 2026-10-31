import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'
import type * as ProcessTablePsCapture from '../../shared/process-table-ps-capture'
import type * as ProcessTableSnapshotReader from '../../shared/process-table-snapshot-reader'
import type * as ProcessHost from '@orca/process-host'

const { captureProcessTableMock, runProcessMock, ttyReads } = vi.hoisted(() => ({
  captureProcessTableMock: vi.fn(),
  runProcessMock: vi.fn(),
  ttyReads: { unrelated: 0, pane: 0 }
}))

vi.mock('../../shared/process-table-ps-capture', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessTablePsCapture>()),
  captureProcessTable: captureProcessTableMock
}))

// Count every read of a captured row's TTY, in place so the shared snapshot keeps its identity; a pass over the whole
// table is visible however it is written.
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessTableSnapshotReader>()
  const counted = new WeakSet<object>()
  const count = (rows: ProcessTableRow[]): ProcessTableRow[] => {
    for (const row of rows) {
      if (counted.has(row)) {
        continue
      }
      counted.add(row)
      const { tty } = row
      const kind =
        tty?.startsWith('pts/') && Number(tty.slice(4)) < UNRELATED_TTY ? 'pane' : 'unrelated'
      Object.defineProperty(row, 'tty', {
        enumerable: true,
        get: () => {
          ttyReads[kind] += 1
          return tty
        }
      })
    }
    return rows
  }
  return {
    ...actual,
    getProcessTableSnapshot: async () => count(await actual.getProcessTableSnapshot()),
    getFreshProcessTableSnapshot: async () => count(await actual.getFreshProcessTableSnapshot())
  }
})

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHost>()),
  runProcess: runProcessMock
}))

import { createPtyForegroundProcessTracker } from './pty-subprocess/foreground-process-tracker'
import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot-reader'
import { getSnapshotRowsOnTty } from '../pty/terminal-process-rows'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

const CODEX = 'node /usr/lib/node_modules/@openai/codex/bin/codex.js'
/** Daemons without a terminal and other users' sessions: the bulk of a real table, owned by no pane. */
const UNRELATED_ROWS = 4_000
const UNRELATED_TTY = 900

function shellPid(pane: number): number {
  return 10_000 + pane * 10
}

/** Linux PS_ARGS rows: every pane runs npm Codex, whose node-pty leader name (`node`) refreshes every second. */
function table(panes: number): string {
  const unrelated = Array.from({ length: UNRELATED_ROWS }, (_, index) => {
    const pid = 500_000 + index
    return index % 4 === 0
      ? `${pid} 1 ${pid} ${pid} S+ pts/${UNRELATED_TTY + (index % 40)} 60 vim notes-${index}.md`
      : `${pid} 1 ${pid} -1 Ss ? 60 /usr/libexec/service-${index}`
  })
  const panesRows = Array.from({ length: panes }, (_, pane) => {
    const shell = shellPid(pane)
    const agent = shell + 1
    return [
      `${shell} 1 ${shell} ${agent} Ss pts/${pane} 9 -zsh`,
      `${agent} ${shell} ${agent} ${agent} S+ pts/${pane} 5 ${CODEX}`
    ]
  })
  return [...unrelated, ...panesRows.flat()].join('\n')
}

function trackers(panes: number) {
  return Array.from({ length: panes }, (_, pane) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracker and resolver read only these members.
    const proc = {
      pid: shellPid(pane),
      process: 'node',
      ptsName: `/dev/pts/${pane}`,
      getForegroundProcessGroup: () => shellPid(pane) + 1
    } as unknown as pty.IPty
    return createPtyForegroundProcessTracker({
      process: proc,
      shellPath: '/bin/zsh',
      sessionId: `pane-${pane}`,
      startupAgentRecognition: null,
      isDead: () => false
    })
  })
}

async function refreshRound(panes: number): Promise<{
  captures: number
  names: string[]
  unrelatedTtyReads: number
  paneTtyReads: number
}> {
  resetProcessTableSnapshotForTests()
  ttyReads.unrelated = 0
  ttyReads.pane = 0
  captureProcessTableMock.mockReset()
  captureProcessTableMock.mockResolvedValue(table(panes))
  const all = trackers(panes)
  for (const tracker of all) {
    tracker.getForegroundProcess()
  }
  await vi.waitFor(() =>
    expect(all.every((tracker) => tracker.getForegroundProcess() === 'codex')).toBe(true)
  )
  return {
    captures: captureProcessTableMock.mock.calls.length,
    names: all.map((tracker) => tracker.getForegroundProcess() ?? ''),
    unrelatedTtyReads: ttyReads.unrelated,
    paneTtyReads: ttyReads.pane
  }
}

function row(pid: number, tty: string | undefined, command: string): ProcessTableRow {
  return { pid, ppid: 1, pgid: pid, tpgid: pid, stat: 'S+', tty, command }
}

describe('display foreground refresh from the PTY master group', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetProcessTableSnapshotForTests()
  })

  it('shares one process-table capture however many panes refresh', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const small = await refreshRound(4)
    const large = await refreshRound(40)

    expect(small.names).toEqual(Array(4).fill('codex'))
    expect(large.names).toEqual(Array(40).fill('codex'))
    expect(small.captures).toBe(1)
    expect(large.captures).toBe(small.captures)
    // No pane spawns its own terminal-scoped ps for display.
    expect(runProcessMock).not.toHaveBeenCalled()
    // Rows no pane owns are visited once per capture to index it, never once per pane.
    expect(small.unrelatedTtyReads).toBeGreaterThan(0)
    expect(small.unrelatedTtyReads).toBeLessThanOrEqual(UNRELATED_ROWS)
    expect(large.unrelatedTtyReads).toBe(small.unrelatedTtyReads)
    // Each pane's own rows cost the same work at any pane count.
    expect(large.paneTtyReads).toBeLessThanOrEqual(10 * small.paneTtyReads)
  })

  it('groups each new snapshot by normalized TTY, in capture order', () => {
    const first = [
      row(1, '/dev/pts/3', 'zsh'),
      row(2, '?', 'launchd'),
      row(3, undefined, 'kernel_task'),
      row(4, 'pts/3', 'claude'),
      row(5, 'console', 'loginwindow')
    ]
    expect(getSnapshotRowsOnTty(first, 'pts/3').map((entry) => entry.pid)).toEqual([1, 4])
    expect(getSnapshotRowsOnTty(first, 'pts/9')).toEqual([])
    // A later capture that reuses the TTY name for another session is regrouped, not served from the first.
    const replacement = [row(7, 'pts/3', 'bash')]
    expect(getSnapshotRowsOnTty(replacement, 'pts/3').map((entry) => entry.pid)).toEqual([7])
    expect(getSnapshotRowsOnTty(first, 'pts/3').map((entry) => entry.pid)).toEqual([1, 4])
  })
})
