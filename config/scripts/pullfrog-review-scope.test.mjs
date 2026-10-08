import { expect, it, vi } from 'vitest'
import scope from './pullfrog-review-scope.cjs'

it('groups a current review by PR while leaving other agent tasks independent', async () => {
  const get = vi.fn(async () => ({ data: { state: 'open', head: { sha: 'current' } } }))
  const core = { setOutput: vi.fn(), warning: vi.fn() }
  const context = {
    repo: { owner: 'stablyai', repo: 'orca' },
    runId: 7,
    payload: { inputs: { name: 'Review #42 [abc]' } }
  }
  const github = {
    rest: {
      pulls: { get },
      actions: { listWorkflowRuns: async () => ({ data: { workflow_runs: [] } }) }
    }
  }
  await scope.reviewScope({ core, context, github })
  expect(get).toHaveBeenCalledWith({ owner: 'stablyai', repo: 'orca', pull_number: 42 })
  expect(core.setOutput).toHaveBeenCalledWith('head', 'current')
  get.mockClear()
  await scope.reviewScope({
    core,
    github,
    context: { ...context, payload: { inputs: { name: 'Investigate #42' } } }
  })
  expect(get).not.toHaveBeenCalled()
  expect(core.setOutput).toHaveBeenLastCalledWith('current', 'true')
})

it('coalesces only explicit or recognized PR review identities', () => {
  expect(scope.reviewNumber({ name: 'Review #23532 [85jpk]' })).toBe(23532)
  expect(scope.reviewNumber({ name: 'Review new commits on #22727 [24lpq]' })).toBe(22727)
  expect(scope.reviewNumber({ pull_request_number: '123' })).toBe(123)
  for (const name of ['Fix #123', 'Review #12; echo test', 'Review #123', '', 'Review #0 [abc]']) {
    expect(scope.reviewNumber({ name })).toBeNull()
  }
})

it('skips closed or explicitly stale reviews and tolerates lookup failure', async () => {
  for (const data of [
    { state: 'closed', head: { sha: 'a' } },
    { state: 'open', head: { sha: 'b' } }
  ]) {
    const core = { setOutput: vi.fn(), warning: vi.fn() }
    await scope.reviewScope({
      core,
      context: {
        repo: {},
        runId: 1,
        payload: { inputs: { pull_request_number: '1', head_sha: 'a' } }
      },
      github: { rest: { pulls: { get: async () => ({ data }) } } }
    })
    expect(core.setOutput).toHaveBeenCalledWith('current', 'false')
  }
  const core = { setOutput: vi.fn(), warning: vi.fn() }
  await scope.reviewScope({
    core,
    context: { repo: {}, runId: 2, payload: { inputs: { pull_request_number: '1' } } },
    github: {
      rest: {
        pulls: {
          get: async () => {
            throw new Error('offline')
          }
        }
      }
    }
  })
  expect(core.setOutput).toHaveBeenCalledWith('current', 'true')
  expect(core.warning).toHaveBeenCalled()
})

it('a delayed older scope cannot cancel or replace a newer review', async () => {
  const runs = [
    { id: 6, display_title: 'Review #42 [a]', status: 'in_progress' },
    { id: 8, display_title: 'Custom review | PR 42', status: 'queued' },
    { id: 5, display_title: 'Investigate #42', status: 'in_progress' },
    { id: 4, display_title: 'Review #43 [other]', status: 'in_progress' }
  ]
  for (const runId of [7, 9]) {
    const cancelWorkflowRun = vi.fn(async () => ({}))
    const core = { setOutput: vi.fn(), warning: vi.fn() }
    await scope.reviewScope({
      context: {
        repo: { owner: 'stablyai', repo: 'orca' },
        runId,
        payload: { inputs: { name: 'Review #42 [current]' } }
      },
      core,
      github: {
        rest: {
          pulls: { get: async () => ({ data: { state: 'open', head: { sha: 'head' } } }) },
          actions: {
            listWorkflowRuns: async () => ({ data: { workflow_runs: runs } }),
            cancelWorkflowRun
          }
        }
      }
    })
    if (runId === 7) {
      expect(cancelWorkflowRun).not.toHaveBeenCalled()
      expect(core.setOutput).toHaveBeenCalledWith('current', 'false')
    } else {
      expect(cancelWorkflowRun.mock.calls.map(([args]) => args.run_id)).toEqual([6, 8])
    }
  }
})
