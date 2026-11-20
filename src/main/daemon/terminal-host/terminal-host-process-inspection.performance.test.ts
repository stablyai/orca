import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  tables.strict.mockReset().mockResolvedValue({ rows: [], capturedAgeMs: 0 })
  tables.cheap.mockReset().mockResolvedValue([])
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
})

function shellPane(foregroundGroup: number): Session {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a steady POSIX poll reads only these members
  return {
    isAlive: true,
    incarnationId: 'incarnation-1',
    pid: 4242,
    processNameIsSpawnFile: false,
    shellIsRootChild: false,
    readForegroundGroup: () => foregroundGroup,
    getForegroundProcess: () => 'zsh'
  } as unknown as Session
}

async function idlePoll(session: Session): Promise<void> {
  for (let poll = 0; poll < 10; poll++) {
    await inspectTerminalHostProcess({
      sessionId: 'pane-1',
      session,
      steadyState: true,
      jobMembershipOnly: true,
      authorityGeneration: 'generation-1',
      nextObservationEpoch: () => poll
    })
  }
}

it('answers idle shell polls without a whole-machine process capture', async () => {
  await idlePoll(shellPane(4242))
  expect(tables.strict).toHaveBeenCalledTimes(0)
  expect(tables.cheap).toHaveBeenCalledTimes(0)
})

it('still takes the full capture when a job owns the terminal', async () => {
  await idlePoll(shellPane(5151))
  expect(tables.strict).toHaveBeenCalledTimes(10)
})
