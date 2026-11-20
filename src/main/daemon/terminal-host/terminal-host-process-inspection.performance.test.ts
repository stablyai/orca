import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetDarwinProcessGroupSizesForTests } from '../../../shared/process-observation/darwin/darwin-process-group-sizes'
import {
  setLibprocAddonForTests,
  type LibprocProcessRow
} from '../../../shared/process-observation/darwin/libproc-addon'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import type { Session } from '../sessions/session'
import { inspectTerminalHostProcess } from './terminal-host-process-inspection'

// Guards PR #45713: idle shell panes polled every few seconds read the whole machine's process table each time.
const tables = vi.hoisted(() => ({ strict: vi.fn(), cheap: vi.fn() }))
vi.mock(
  '../../../shared/process-observation/tables/process-table-snapshot-reader',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getStrictProcessTableSnapshotWithAge: tables.strict
  })
)
vi.mock(
  '../../../shared/process-observation/tables/cheap-process-table-snapshot-reader',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getCheapProcessTableSnapshot: tables.cheap
  })
)

const platform = process.platform
const SHELL = 4242
let shellGroupMembers = 1
const groupReads = vi.fn()

function kinfo(pid: number, pgid: number): LibprocProcessRow {
  return {
    pid,
    ppid: 1,
    pgid,
    tpgid: pgid,
    tdev: 1,
    status: 3,
    flags: 0,
    sessionLeader: false,
    startSec: 0,
    comm: 'zsh'
  }
}

beforeEach(() => {
  shellGroupMembers = 1
  groupReads.mockReset()
  resetDarwinProcessGroupSizesForTests()
  setLibprocAddonForTests({
    readProcessTable: async (query) => {
      groupReads(query)
      return Array.from({ length: shellGroupMembers }, (_, i) => kinfo(SHELL + i, SHELL))
    }
  })
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.useFakeTimers()
  vi.setSystemTime(0)
  tables.cheap.mockReset().mockResolvedValue([])
})

afterEach(() => {
  setLibprocAddonForTests(undefined)
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', { value: platform })
})

function row(pid: number, ppid: number, pgid: number, command: string): ProcessTableRow {
  return { pid, ppid, pgid, tpgid: SHELL, stat: 'S', tty: 'ttys001', command }
}

function pane(options: {
  root: number
  shellIsRootChild: boolean
  foregroundGroup: number
}): Session {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a steady POSIX poll reads only these members
  return {
    isAlive: true,
    incarnationId: 'incarnation-1',
    pid: options.root,
    processNameIsSpawnFile: false,
    shellIsRootChild: options.shellIsRootChild,
    outputChunks: 0,
    readForegroundGroup: () => options.foregroundGroup,
    getForegroundProcess: () => 'zsh'
  } as unknown as Session
}

/** Ten steady polls of a pane with no tracked agent, 15 s apart (the quiet-pane cadence). */
async function pollQuietPane(
  session: Session,
  rows: ProcessTableRow[],
  between: (poll: number) => void = () => {}
): Promise<number> {
  tables.strict.mockReset().mockResolvedValue({ rows, capturedAgeMs: 0 })
  for (let poll = 0; poll < 10; poll++) {
    await inspectTerminalHostProcess({
      sessionId: 'pane-1',
      session,
      steadyState: true,
      jobMembershipOnly: true,
      authorityGeneration: 'generation-1',
      nextObservationEpoch: () => poll
    })
    between(poll)
    vi.advanceTimersByTime(15_000)
  }
  return tables.strict.mock.calls.length
}

it('re-proves an idle shell once a minute instead of capturing every poll', async () => {
  const session = pane({ root: SHELL, shellIsRootChild: false, foregroundGroup: SHELL })
  expect(await pollQuietPane(session, [row(SHELL, 1, SHELL, '-zsh')])).toBe(3)
  expect(tables.cheap).toHaveBeenCalledTimes(0)
})

it('re-proves a login-wrapped idle shell without a per-pane read', async () => {
  const session = pane({ root: 4000, shellIsRootChild: true, foregroundGroup: SHELL })
  const rows = [row(4000, 1, 4000, 'login -pfl user /bin/zsh'), row(SHELL, 4000, SHELL, '-zsh')]
  expect(await pollQuietPane(session, rows)).toBe(3)
})

it('captures every poll while a job owns the terminal', async () => {
  const session = pane({ root: SHELL, shellIsRootChild: false, foregroundGroup: 5151 })
  expect(await pollQuietPane(session, [row(SHELL, 1, SHELL, '-zsh')])).toBe(10)
})

it('captures every poll while a command shares the shell group (job control off)', async () => {
  const session = pane({ root: SHELL, shellIsRootChild: false, foregroundGroup: SHELL })
  const rows = [row(SHELL, 1, SHELL, '-zsh'), row(5151, SHELL, SHELL, 'codex')]
  expect(await pollQuietPane(session, rows)).toBe(10)
})

it('captures again on the next poll after the pane prints', async () => {
  const session = pane({ root: SHELL, shellIsRootChild: false, foregroundGroup: SHELL })
  // A command sharing the shell group (job control off) prints while it runs.
  let capturesAfterNextPoll = 0
  const printOnce = (poll: number): void => {
    if (poll === 1) {
      Object.assign(session, { outputChunks: 1 })
    }
    if (poll === 2) {
      capturesAfterNextPoll = tables.strict.mock.calls.length
    }
  }
  await pollQuietPane(session, [row(SHELL, 1, SHELL, '-zsh')], printOnce)
  expect(capturesAfterNextPoll).toBe(2)
})

it('captures again on the next poll after a silent command joins the shell group', async () => {
  const session = pane({ root: SHELL, shellIsRootChild: false, foregroundGroup: SHELL })
  let capturesAfterNextPoll = 0
  const joinSilently = (poll: number): void => {
    if (poll === 1) {
      shellGroupMembers = 2
    }
    if (poll === 2) {
      capturesAfterNextPoll = tables.strict.mock.calls.length
    }
  }
  await pollQuietPane(session, [row(SHELL, 1, SHELL, '-zsh')], joinSilently)
  expect(capturesAfterNextPoll).toBe(2)
})

it('captures every poll when the native reader cannot read groups', async () => {
  setLibprocAddonForTests({ readProcessTable: async () => null })
  const session = pane({ root: SHELL, shellIsRootChild: false, foregroundGroup: SHELL })
  expect(await pollQuietPane(session, [row(SHELL, 1, SHELL, '-zsh')])).toBe(10)
})

it('shares one group read per round however many idle panes poll in it', async () => {
  async function pollRounds(panes: number): Promise<{ captures: number; groupReads: number }> {
    resetDarwinProcessGroupSizesForTests()
    groupReads.mockReset()
    const shells = Array.from({ length: panes }, (_, i) => 10_000 + i)
    const sessions = shells.map((pid) =>
      pane({ root: pid, shellIsRootChild: false, foregroundGroup: pid })
    )
    const rows = shells.map((pid) => ({ ...row(pid, 1, pid, '-zsh'), tpgid: pid }))
    setLibprocAddonForTests({
      readProcessTable: async (query) => {
        groupReads(query)
        return shells.map((pid) => kinfo(pid, pid))
      }
    })
    // One capture serves the whole round, already 200 ms old when later panes join it.
    tables.strict.mockReset().mockResolvedValue({ rows, capturedAgeMs: 200 })
    for (let round = 0; round < 10; round++) {
      await Promise.all(
        sessions.map((session, i) =>
          inspectTerminalHostProcess({
            sessionId: `pane-${i}`,
            session,
            steadyState: true,
            jobMembershipOnly: true,
            authorityGeneration: 'generation-1',
            nextObservationEpoch: () => round
          })
        )
      )
      vi.advanceTimersByTime(15_000)
    }
    return { captures: tables.strict.mock.calls.length, groupReads: groupReads.mock.calls.length }
  }
  // Each pane re-proves once a minute (3 of 10 rounds); the other 7 rounds share one kinfo-only read each.
  expect(await pollRounds(30)).toEqual({ captures: 90, groupReads: 7 })
  expect(await pollRounds(300)).toEqual({ captures: 900, groupReads: 7 })
  expect(groupReads).toHaveBeenCalledWith({ command: false })
})
