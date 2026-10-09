import { afterEach, expect, it, vi } from 'vitest'
import { executeBacklogOperation } from './backlog-service'
import { loadBacklogProject, readBacklogTasks } from './backlog-project'
import { runBacklogMutation } from './backlog-cli'
import { BACKLOG_OPERATION_TIMEOUT_MS } from '../../shared/backlog-types'

vi.mock('./backlog-project', () => ({
  loadBacklogProject: vi.fn(),
  readBacklogTasks: vi.fn().mockResolvedValue([]),
  assertBacklogMutationPaths: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./backlog-cli', () => ({
  backlogMutationUnavailable: vi.fn().mockReturnValue(null),
  resolveBacklogCli: vi.fn(),
  runBacklogMutation: vi.fn()
}))
const project = {
  root: '/project',
  backlogPath: '/project/backlog',
  projectName: 'Test',
  statuses: ['Inbox'],
  config: { statuses: ['Inbox'] },
  unsafeCliConfig: false,
  configMatchesCli: true
}
const create = { kind: 'create', title: 'Task', description: '', status: 'Inbox' } as const

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('bounds scanning and never starts a late mutation after the overall deadline', async () => {
  vi.useFakeTimers()
  let release: (value: typeof project) => void = () => {}
  vi.mocked(loadBacklogProject).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve
    })
  )
  const result = expect(executeBacklogOperation('/project', create)).rejects.toThrow(
    'Completion is unconfirmed'
  )
  await vi.advanceTimersByTimeAsync(BACKLOG_OPERATION_TIMEOUT_MS)
  await result
  release(project)
  await vi.advanceTimersByTimeAsync(0)
  expect(readBacklogTasks).toHaveBeenCalledOnce()
  expect(runBacklogMutation).not.toHaveBeenCalled()
})

it('aborts an in-flight command at the overall deadline without retrying', async () => {
  vi.useFakeTimers()
  vi.mocked(loadBacklogProject).mockResolvedValueOnce(project)
  vi.mocked(runBacklogMutation).mockImplementationOnce(
    async (_project, _operation, _previous, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
    }
  )
  const result = expect(executeBacklogOperation('/project', create)).rejects.toThrow(
    'Completion is unconfirmed'
  )
  await vi.advanceTimersByTimeAsync(BACKLOG_OPERATION_TIMEOUT_MS)
  await result
  expect(runBacklogMutation).toHaveBeenCalledOnce()
  expect(vi.mocked(runBacklogMutation).mock.calls[0][3].aborted).toBe(true)
})
