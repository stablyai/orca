// Regression guard for the SHIPPED inventory path. `pty.listProcesses` resolves
// every managed pane's title from one batched host capture; a per-pane tree walk
// would restore the O(panes x rows) scan on the relay's single event-loop thread,
// and a batched result that cannot name the foreground process must fall back to
// node-pty's own name rather than relabelling a live pane "shell".
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const {
  mockPtySpawn,
  mockPtyInstance,
  mockCreateShellPromptReadinessProbe,
  mockGetStrictProcessTableSnapshot,
  mockGetStrictProcessTableSnapshotWithAge
} = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockGetStrictProcessTableSnapshot: vi.fn(),
  mockGetStrictProcessTableSnapshotWithAge: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    process: 'zsh',
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

vi.mock('../shared/process-table-snapshot-reader', async (importOriginal) => {
  const actual = await importOriginal<ProcessTableSnapshotModule>()
  return {
    ...actual,
    getStrictProcessTableSnapshot: mockGetStrictProcessTableSnapshot,
    getStrictProcessTableSnapshotWithAge: mockGetStrictProcessTableSnapshotWithAge
  }
})

import type * as processTableSnapshotModule from '../shared/process-table-snapshot-reader'
import type { ProcessTableRow } from '../shared/process-table-snapshot'

type ProcessTableSnapshotModule = typeof processTableSnapshotModule
import * as ptyShellUtils from './pty-shell-utils'
import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  createPtyRequestHelpers,
  endPtyHandlerTest
} from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

type ProcessSummary = { id: string; title: string }

/** A shell root plus its foreground children, as `ps` reports them. */
function paneRows(rootPid: number, commands: string[]): ProcessTableRow[] {
  const foregroundPgid = rootPid + 1
  return [
    {
      pid: rootPid,
      ppid: 1,
      pgid: rootPid,
      tpgid: foregroundPgid,
      stat: 'Ss',
      command: '/bin/zsh'
    },
    ...commands.map((command, index) => ({
      pid: foregroundPgid + index,
      ppid: index === 0 ? rootPid : foregroundPgid + index - 1,
      pgid: foregroundPgid,
      tpgid: foregroundPgid,
      stat: 'S+',
      command
    }))
  ]
}

/** Counts element reads so a per-pane rescan of the table cannot pass unseen. */
function countingRows(rows: ProcessTableRow[]): {
  rows: readonly ProcessTableRow[]
  reads: () => number
} {
  let reads = 0
  const proxy = new Proxy(rows, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads += 1
      }
      return Reflect.get(target, key, receiver)
    }
  })
  return { rows: proxy, reads: () => reads }
}

describe('PtyHandler inventory foreground evidence', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  const { spawnPty } = createPtyRequestHelpers(() => dispatcher)

  async function spawnPane(pid: number, processName: string): Promise<string> {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      pid,
      process: processName,
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn()
    })
    return (await spawnPty()).id
  }

  async function listProcesses(): Promise<ProcessSummary[]> {
    return (await dispatcher.callRequest('pty.listProcesses', {})) as ProcessSummary[]
  }

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
    mockGetStrictProcessTableSnapshot.mockReset()
    mockGetStrictProcessTableSnapshotWithAge.mockReset()
    mockGetStrictProcessTableSnapshotWithAge.mockImplementation(async () => ({
      rows: await mockGetStrictProcessTableSnapshot(),
      capturedAgeMs: 0
    }))
    vi.spyOn(ptyShellUtils, 'isProcessAlive').mockReturnValue(true)
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('names each pane from the batched capture', async () => {
    const rows = [...paneRows(1000, ['node /opt/codex']), ...paneRows(2000, ['vim notes.txt'])]
    mockGetStrictProcessTableSnapshot.mockResolvedValue(rows)
    await spawnPane(1000, 'zsh')
    await spawnPane(2000, 'vim')

    expect((await listProcesses()).map((entry) => entry.title)).toEqual(['codex', 'vim'])
  })

  it('keeps the node-pty name when the capture cannot disambiguate a wrapper', async () => {
    // Two same-group `node` children (dev server + worker): the batch refuses to
    // guess, and the pane must stay "node" rather than being relabelled a shell.
    mockGetStrictProcessTableSnapshot.mockResolvedValue(
      paneRows(3000, ['node /srv/app/server.js', 'node /srv/app/worker.js'])
    )
    await spawnPane(3000, 'node')

    expect((await listProcesses())[0].title).toBe('node')
  })

  // The cost that matters is per-CAPTURE, not per-pane: the defect this guards against is a
  // full-table walk for every pane, which is what an O(PTY x rows) inventory looked like. Two
  // linear passes build the two indexes the resolver reads — parent/child correlation, and which
  // process groups occupy each controlling terminal — and neither grows with the pane count.
  const CAPTURE_PASSES = 2

  it.each([1, 8])(
    'walks the host table a fixed number of times for %s panes',
    async (paneCount) => {
      const table = Array.from({ length: paneCount }, (_, index) =>
        paneRows(10_000 + index * 10, ['node /opt/codex'])
      ).flat()
      const { rows, reads } = countingRows(table)
      mockGetStrictProcessTableSnapshot.mockResolvedValue(rows)
      for (let index = 0; index < paneCount; index += 1) {
        await spawnPane(10_000 + index * 10, 'zsh')
      }

      const listed = await listProcesses()

      expect(listed).toHaveLength(paneCount)
      expect(listed.every((entry) => entry.title === 'codex')).toBe(true)
      expect(mockGetStrictProcessTableSnapshot).toHaveBeenCalledTimes(1)
      // Linear in the capture — NOT one full-table walk per pane, which would be
      // `table.length * paneCount` here.
      expect(reads()).toBe(table.length * CAPTURE_PASSES)
    }
  )

  it('returns fenced inspect evidence and echoes the PTY incarnation', async () => {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      pid: 4000,
      process: 'zsh',
      onData: vi.fn(),
      onExit: vi.fn(),
      kill: vi.fn()
    })
    const spawned = await spawnPty({ cols: 80, rows: 24 })
    mockGetStrictProcessTableSnapshot.mockResolvedValue([
      {
        pid: 4000,
        ppid: 1,
        pgid: 4000,
        tpgid: 4001,
        tty: '/dev/pts/9',
        startTime: 'anchor-start',
        stat: 'Ss',
        command: '/bin/zsh'
      },
      {
        pid: 4001,
        ppid: 4000,
        pgid: 4001,
        tpgid: 4001,
        tty: '/dev/pts/9',
        startTime: 'candidate-start',
        stat: 'S+',
        command: 'node /opt/codex'
      }
    ])
    const inspection = await dispatcher.callRequest('pty.inspectProcess', {
      id: spawned.id,
      expectedIncarnationId: spawned.incarnationId
    })

    expect(inspection).toMatchObject({
      foregroundProcess: 'codex',
      foregroundProcessEvidence: {
        verdict: 'live',
        ptyId: spawned.id,
        ptyIncarnationId: spawned.incarnationId,
        fence: {
          platform: 'posix',
          shellPid: 4000,
          shellStartTime: 'anchor-start',
          tty: '/dev/pts/9',
          foregroundPgid: 4001,
          process: { pid: 4001, startTime: 'candidate-start' }
        }
      }
    })
    expect(mockGetStrictProcessTableSnapshot).toHaveBeenCalledOnce()
  })

  it('skips process capture for the no-evidence inventory projection', async () => {
    await spawnPane(5000, 'zsh')
    mockGetStrictProcessTableSnapshot.mockReset()

    const result = await dispatcher.callRequest('pty.listProcesses', {
      includeForegroundProcessEvidence: false
    })

    expect(result).toHaveLength(1)
    expect(mockGetStrictProcessTableSnapshot).not.toHaveBeenCalled()
  })
})
