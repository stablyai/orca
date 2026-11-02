import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { makeRequest, repoDispatcher } from './repo-rpc.test-fixture'

describe('project prompt template RPC', () => {
  it('updates and resets project prompt templates through the runtime contract', async () => {
    const updateProject = vi.fn().mockReturnValue({ id: 'project-1' })
    const dispatcher = repoDispatcher({ getRuntimeId: () => 'test-runtime', updateProject })
    for (const template of ['{url} /engineer', null]) {
      const response = await dispatcher.dispatch(
        makeRequest('project.update', {
          projectId: 'project-1',
          updates: { linkedWorkItemPromptTemplate: template }
        })
      )
      expect(response).toMatchObject({ ok: true })
      expect(updateProject).toHaveBeenLastCalledWith('project-1', {
        linkedWorkItemPromptTemplate: template
      })
    }
    const invalid = await dispatcher.dispatch(
      makeRequest('project.update', {
        projectId: 'project-1',
        updates: { linkedWorkItemPromptTemplate: 12 }
      })
    )
    expect(invalid).toMatchObject({ ok: false })
    expect(updateProject).toHaveBeenCalledTimes(2)
  })
})
