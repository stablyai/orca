import { beforeEach, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))
import { glApi } from './gitlab'

beforeEach(() => invoke.mockReset())

it('preserves the optional review scope through the existing desktop details channel', async () => {
  const args = { repoPath: '/repo', iid: 12, type: 'mr' as const, includeReviewDetails: false }
  const details = { body: 'MR body', comments: [], pipelineJobs: [] }
  invoke.mockResolvedValue(details)
  expect(await glApi.workItemDetails(args)).toBe(details)
  expect(invoke).toHaveBeenCalledWith('gitlab:workItemDetails', args)
  const defaultArgs = { repoPath: '/repo', iid: 12, type: 'mr' as const }
  await glApi.workItemDetails(defaultArgs)
  expect(invoke).toHaveBeenLastCalledWith('gitlab:workItemDetails', defaultArgs)
})
