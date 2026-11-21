import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import {
  setLibprocAddonForTests,
  type LibprocProcessRow
} from '../../../shared/process-observation/darwin/libproc-addon'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import type { Session } from '../sessions/session'
import { resetIdleShellGroupSizesForTests } from './terminal-host-idle-shell-proof'
import { inspectTerminalHostProcess } from './terminal-host-process-inspection'

// Guards PR #45713: idle shell panes polled every few seconds read the whole machine's process table each time.
type LastCapture = { capture: Promise<{ rows: ProcessTableRow[] }>; at: number }
const tables = vi.hoisted((): { strict: Mock; last: LastCapture | null } => ({
  strict: vi.fn(),
  last: null
}))
vi.mock(
  '../../../shared/process-observation/tables/process-table-snapshot-reader',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getStrictProcessTableSnapshotWithAge: () => {
      const capture = tables.strict()
      tables.last = { capture, at: Date.now() }
      return capture
    },
    // A capture serves later readers for 500 ms, as the shared reader's cache does.
    peekStrictProcessTableSnapshot: () =>
      tables.last && Date.now() - tables.last.at < 500
        ? tables.last.capture.then((snapshot) => snapshot.rows)
        : null
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
  tables.last = null
  resetIdleShellGroupSizesForTests()
  setLibprocAddonForTests({
    readProcessTable: async (query) => {
      groupReads(query)
      return Array.from({ length: shellGroupMembers }, (_, i) => kinfo(SHELL + i, SHELL))
    }
  })
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.useFakeTimers()
  vi.setSystemTime(0)
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
  foreground?: string
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
    getForegroundProcess: () => options.foreground ?? 'zsh'
  } as unknown as Session
}

/** Let a poll's round-join wait elapse on the fake clock, then take its result. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(100)
  return pending
}

/** Ten steady polls of a pane with no tracked agent, 15 s apart (the quiet-pane cadence). */
async function pollQuietPane(
  session: Session,
  rows: ProcessTableRow[],
  between: (poll: number) => void = () => {}
): Promise<number> {
  tables.strict.mockReset().mockResolvedValue({ rows, capturedAgeMs: 0 })
  for (let poll = 0; poll < 10; poll++) {
    await settle(
      inspectTerminalHostProcess({
        sessionId: 'pane-1',
        session,
        steadyState: true,
        jobMembershipOnly: true,
        authorityGeneration: 'generation-1',
        nextObservationEpoch: () => poll
      })
    )
    between(poll)
    vi.advanceTimersByTime(15_000)
  }
  return tables.strict.mock.calls.length
}

it('re-proves an idle shell once a minute instead of capturing every poll', async () => {
  const session = pane({ root: SHELL, shellIsRootChild: false, foregroundGroup: SHELL })
  expect(await pollQuietPane(session, [row(SHELL, 1, SHELL, '-zsh')])).toBe(3)
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
  async function pollRounds(
    panes: number
  ): Promise<{ captures: number; groupReads: number; shortTimers: number }> {
    tables.last = null
    resetIdleShellGroupSizesForTests()
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
    const timers = vi.spyOn(globalThis, 'setTimeout')
    for (let round = 0; round < 10; round++) {
      await settle(
        Promise.all(
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
      )
      vi.advanceTimersByTime(15_000)
    }
    // Only evidence budgets (1.2 s, cleared when a read settles) may be armed: a shorter timer would wake an idle host.
    const shortTimers = timers.mock.calls.filter(([, ms]) => (ms ?? 0) < 1_200).length
    timers.mockRestore()
    return {
      captures: tables.strict.mock.calls.length,
      groupReads: groupReads.mock.calls.length,
      shortTimers
    }
  }
  // Each pane re-proves once a minute (3 of 10 rounds); the other 7 rounds share one kinfo-only read each.
  expect(await pollRounds(30)).toEqual({ captures: 90, groupReads: 7, shortTimers: 0 })
  expect(await pollRounds(300)).toEqual({ captures: 900, groupReads: 7, shortTimers: 0 })
  expect(groupReads).toHaveBeenCalledWith({ command: false })
})

it('takes group sizes from the full capture an ordinary command already needs in the same round', async () => {
  async function pollRounds(panes: number): Promise<{ captures: number; groupReads: number }> {
    resetIdleShellGroupSizesForTests()
    groupReads.mockReset()
    tables.last = null
    const shells = Array.from({ length: panes }, (_, i) => 10_000 + i)
    const idle = shells.map((pid) =>
      pane({ root: pid, shellIsRootChild: false, foregroundGroup: pid })
    )
    const editor = pane({
      root: 9_000,
      shellIsRootChild: false,
      foregroundGroup: 9_001,
      foreground: 'vim'
    })
    const rows = [
      ...shells.map((pid) => ({ ...row(pid, 1, pid, '-zsh'), tpgid: pid })),
      { ...row(9_000, 1, 9_000, '-zsh'), tpgid: 9_001 },
      { ...row(9_001, 9_000, 9_001, 'vim'), tpgid: 9_001 }
    ]
    tables.strict.mockReset().mockResolvedValue({ rows, capturedAgeMs: 0 })
    const poll = (session: Session, id: string, round: number) =>
      inspectTerminalHostProcess({
        sessionId: id,
        session,
        steadyState: true,
        jobMembershipOnly: true,
        authorityGeneration: 'generation-1',
        nextObservationEpoch: () => round
      })
    for (let round = 0; round < 10; round++) {
      // The editor's poll arrives after the idle panes' in the same round.
      const idlePolls = idle.map((session, i) => poll(session, `pane-${i}`, round))
      await settle(Promise.all([...idlePolls, poll(editor, 'editor', round)]))
      vi.advanceTimersByTime(15_000)
    }
    return { captures: tables.strict.mock.calls.length, groupReads: groupReads.mock.calls.length }
  }
  // The editor captures every round, as before; idle panes re-prove once a minute and add no read of their own.
  expect(await pollRounds(30)).toEqual({ captures: 10 + 3 * 30, groupReads: 0 })
  expect(await pollRounds(300)).toEqual({ captures: 10 + 3 * 300, groupReads: 0 })
})

it('keeps a known agent from per-pid reads alone, and captures once it exits', async () => {
  const AGENT = 5151
  const rows: ProcessTableRow[] = [
    { ...row(SHELL, 1, SHELL, '-zsh'), tpgid: AGENT, startTime: 'Mon Nov 20 10:00:00 2026' },
    { ...row(AGENT, SHELL, AGENT, 'claude'), tpgid: AGENT, startTime: 'Mon Nov 20 10:01:00 2026' }
  ]
  let agentAlive = true
  setLibprocAddonForTests({
    readProcessTable: async (query) => {
      groupReads(query)
      return agentAlive ? [{ ...kinfo(AGENT, AGENT), comm: 'claude' }] : []
    }
  })
  const session = pane({
    root: SHELL,
    shellIsRootChild: false,
    foregroundGroup: AGENT,
    foreground: 'claude'
  })
  tables.strict.mockReset().mockResolvedValue({ rows, capturedAgeMs: 0 })
  const poll = (epoch: number) =>
    settle(
      inspectTerminalHostProcess({
        sessionId: 'pane-1',
        session,
        steadyState: true,
        authorityGeneration: 'generation-1',
        nextObservationEpoch: () => epoch
      })
    )
  for (let epoch = 0; epoch < 10; epoch++) {
    expect((await poll(epoch)).foregroundProcess).toBe('claude')
    vi.advanceTimersByTime(15_000)
  }
  expect(tables.strict).toHaveBeenCalledTimes(1)
  // Every read named the pids: no whole-machine table.
  expect(groupReads.mock.calls.every(([query]) => query.pids?.length === 1)).toBe(true)
  agentAlive = false
  await poll(10)
  expect(tables.strict).toHaveBeenCalledTimes(2)
})

it('confirms N resting agents polled together with one native read', async () => {
  async function steadyRoundReads(panes: number): Promise<number> {
    const rows: ProcessTableRow[] = []
    const sessions: Session[] = []
    for (let i = 0; i < panes; i++) {
      const shell = 10_000 + i * 2
      const agent = shell + 1
      const tty = `ttys${i}`
      rows.push(
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
      )
      sessions.push({
        ...pane({
          root: shell,
          shellIsRootChild: false,
          foregroundGroup: agent,
          foreground: 'claude'
        }),
        pid: shell
      } as Session)
    }
    setLibprocAddonForTests({
      readProcessTable: async (query) => {
        groupReads(query)
        return (query.pids ?? []).map((pid) => ({ ...kinfo(pid, pid), comm: 'claude' }))
      }
    })
    tables.strict.mockReset().mockResolvedValue({ rows, capturedAgeMs: 0 })
    const round = (epoch: number) =>
      settle(
        Promise.all(
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
      )
    await round(0)
    vi.advanceTimersByTime(15_000)
    groupReads.mockReset()
    const results = await round(1)
    expect(results.every((result) => result.foregroundProcess === 'claude')).toBe(true)
    expect(tables.strict).toHaveBeenCalledTimes(panes)
    return groupReads.mock.calls.length
  }
  expect(await steadyRoundReads(10)).toBe(1)
  expect(await steadyRoundReads(100)).toBe(1)
})
