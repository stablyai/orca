import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { makeRequest, repoDispatcher } from './repo-rpc.test-fixture'

describe('project default agent RPC updates', () => {
  it('passes a project default agent through project.update and rejects unknown agents', async () => {
    const updateProject = vi.fn().mockReturnValue({ id: 'project-1', defaultTuiAgent: 'blank' })
    const dispatcher = repoDispatcher({ getRuntimeId: () => 'test-runtime', updateProject })
    const accepted = await dispatcher.dispatch(
      makeRequest('project.update', {
        projectId: 'project-1',
        updates: { defaultTuiAgent: 'blank' }
      })
    )
    expect(accepted).toMatchObject({ ok: true, result: { project: { defaultTuiAgent: 'blank' } } })
    expect(updateProject).toHaveBeenCalledWith('project-1', { defaultTuiAgent: 'blank' })

    const rejected = await dispatcher.dispatch(
      makeRequest('project.update', {
        projectId: 'project-1',
        updates: { defaultTuiAgent: 'unknown-agent' }
      })
    )
    expect(rejected.ok).toBe(false)
    expect(updateProject).toHaveBeenCalledTimes(1)
  })
})
