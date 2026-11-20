import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.useFakeTimers()
  vi.setSystemTime(0)
  tables.cheap.mockReset().mockResolvedValue([])
})

afterEach(() => {
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
    readForegroundGroup: () => options.foregroundGroup,
    getForegroundProcess: () => 'zsh'
  } as unknown as Session
}

/** Ten steady polls of a pane with no tracked agent, 15 s apart (the quiet-pane cadence). */
async function pollQuietPane(session: Session, rows: ProcessTableRow[]): Promise<number> {
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
