import { describe, expect, it } from 'vitest'
import { mobileWebWorkspaceActivation } from './mobile-web-workspace-activation'

describe('mobile web workspace activation', () => {
  it('keeps only the bounded activation result', () => {
    expect(
      mobileWebWorkspaceActivation(
        {
          repoId: 'repo-1',
          worktreeId: 'workspace-1',
          activated: true,
          sleepingAgentWake: 'requested',
          credential: 'must-not-cross'
        },
        'workspace-1',
        'opaque-workspace'
      )
    ).toEqual({
      workspaceId: 'opaque-workspace',
      activated: true,
      sleepingAgentWake: 'requested'
    })
  })

  it('rejects a response for a different workspace', () => {
    expect(() =>
      mobileWebWorkspaceActivation(
        {
          worktreeId: 'workspace-2',
          activated: true,
          sleepingAgentWake: 'not-applicable'
        },
        'workspace-1',
        'opaque-workspace'
      )
    ).toThrow('mobile_web_workspace_activation_invalid')
  })
})
