import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type {
  LibprocAddon,
  LibprocProcessRow,
  LibprocQuery
} from '../../../shared/process-observation/darwin/libproc-addon'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import type { Session } from '../sessions/session'
import { inspectTerminalHostProcess } from './terminal-host-process-inspection'

// Perf contract (#46511): every steady poll of a pane running a known agent read the whole machine's process table.
const native = vi.hoisted((): { addon: LibprocAddon | null; reads: LibprocQuery[] } => ({
  addon: null,
  reads: []
}))
const tables = vi.hoisted((): { strict: Mock; cheap: Mock } => ({
  strict: vi.fn(),
  cheap: vi.fn()
}))
vi.mock('../../../shared/process-observation/darwin/libproc-addon', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadLibprocAddon: () => native.addon
}))
vi.mock(
  '../../../shared/process-observation/tables/process-table-snapshot-reader',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getStrictProcessTableSnapshotWithAge: () => tables.strict(),
    peekStrictProcessTableSnapshot: () => null
  })
)
vi.mock(
  '../../../shared/process-observation/tables/cheap-process-table-snapshot-reader',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getCheapProcessTableSnapshot: () => tables.cheap()
  })
)

const platform = process.platform

beforeEach(() => {
  native.reads = []
  tables.strict.mockReset()
  tables.cheap.mockReset().mockResolvedValue([])
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  native.addon = null
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { value: platform })
})

/** A native reader that answers named pids (or the whole table) with live agent rows. */
function agentAddon(alive: () => readonly number[]): LibprocAddon {
  return {
    readProcessTable: async (query) => {
      native.reads.push(query)
      const pids = query.pids ?? alive()
      return pids
        .filter((pid) => alive().includes(pid))
        .map((pid): LibprocProcessRow => ({
          pid,
          ppid: 1,
          pgid: pid,
          tpgid: pid,
          tdev: 1,
          status: 3,
          flags: 0,
          sessionLeader: false,
          startSec: 0,
          comm: 'claude'
        }))
    }
  }
}

/** A shell pane whose terminal is held by `agent`, with the capture rows a full inspection reads. */
function agentPane(index: number): { session: Session; agent: number; rows: ProcessTableRow[] } {
  const shell = 10_000 + index * 2
  const agent = shell + 1
  const tty = `ttys${index}`
  const rows: ProcessTableRow[] = [
    {
      pid: shell,
      ppid: 1,
      pgid: shell,
      tpgid: agent,
      stat: 'S',
      tty,
      command: '-zsh',
      startTime: 'Mon Nov 20 10:00:00 2026'
    },
    {
      pid: agent,
      ppid: shell,
      pgid: agent,
      tpgid: agent,
      stat: 'S',
      tty,
      command: 'claude',
      startTime: 'Mon Nov 20 10:01:00 2026'
    }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a steady POSIX poll reads only these members
  const session = {
    isAlive: true,
    incarnationId: 'incarnation-1',
    pid: shell,
    processNameIsSpawnFile: false,
    shellIsRootChild: false,
    outputChunks: 0,
    readForegroundGroup: () => agent,
    getForegroundProcess: () => 'claude'
  } as unknown as Session
  return { session, agent, rows }
}

/** One steady round over every pane; the fake clock lets a poll's round-join wait elapse. */
async function pollRound(sessions: readonly Session[], epoch: number) {
  const pending = Promise.all(
    sessions.map((session, i) =>
      inspectTerminalHostProcess({
        sessionId: `pane-${i}`,
        session,
        steadyState: true,
        authorityGeneration: 'generation-1',
        nextObservationEpoch: () => epoch
      })
    )
  )
  await vi.advanceTimersByTimeAsync(100)
  return pending
}

/** Whole-machine table reads: captures through either shared reader, plus native reads that name no pids. */
function wholeTableReads(): number {
  return (
    tables.strict.mock.calls.length +
    tables.cheap.mock.calls.length +
    native.reads.filter((query) => query.pids === undefined).length
  )
}

it('keeps a resting agent from per-pid reads alone, and captures once it exits', async () => {
  const { session, agent, rows } = agentPane(0)
  let alive = [agent]
  native.addon = agentAddon(() => alive)
  tables.strict.mockResolvedValue({ rows, capturedAgeMs: 0 })

  for (let epoch = 0; epoch < 10; epoch++) {
    const [result] = await pollRound([session], epoch)
    expect(result?.foregroundProcess).toBe('claude')
    vi.advanceTimersByTime(15_000)
  }
  // One capture anchors the agent; the next nine polls read only its pid.
  expect(wholeTableReads()).toBe(1)

  alive = []
  await pollRound([session], 10)
  expect(tables.strict).toHaveBeenCalledTimes(2)
})

it('confirms N resting agents polled together with one native read', async () => {
  async function steadyRoundNativeReads(panes: number): Promise<string[]> {
    const fleet = Array.from({ length: panes }, (_, i) => agentPane(i))
    native.addon = agentAddon(() => fleet.map((pane) => pane.agent))
    tables.strict.mockReset().mockImplementation(async () => ({
      rows: fleet.flatMap((pane) => pane.rows),
      capturedAgeMs: 0
    }))
    tables.cheap.mockReset().mockResolvedValue([])
    const sessions = fleet.map((pane) => pane.session)
    await pollRound(sessions, 0)
    vi.advanceTimersByTime(15_000)
    native.reads = []
    tables.strict.mockClear()
    const results = await pollRound(sessions, 1)
    expect(results.every((result) => result.foregroundProcess === 'claude')).toBe(true)
    expect(tables.strict.mock.calls.length + tables.cheap.mock.calls.length).toBe(0)
    return native.reads.map((query) => (query.pids ? `${query.pids.length} pids` : 'whole table'))
  }
  expect(await steadyRoundNativeReads(10)).toEqual(['10 pids'])
  expect(await steadyRoundNativeReads(100)).toEqual(['100 pids'])
  // Past 256 named pids one kinfo-only table read is cheaper, by design; still one read per round, not one per pane.
  expect(await steadyRoundNativeReads(1_000)).toEqual(['whole table'])
})
