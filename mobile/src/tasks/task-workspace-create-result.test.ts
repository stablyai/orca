import { describe, expect, it } from 'vitest'
import { readTaskWorkspaceCreatedResult } from './task-workspace-create-result'

describe('readTaskWorkspaceCreatedResult', () => {
  it('returns a created workspace', () => {
    expect(
      readTaskWorkspaceCreatedResult({ worktree: { id: 'wt-1', displayName: 'Task' } })
    ).toEqual({ worktree: { id: 'wt-1', displayName: 'Task' } })
  })

  it('surfaces a pre-create custom-agent failure without dereferencing worktree', () => {
    expect(() =>
      readTaskWorkspaceCreatedResult({
        created: false,
        agentLaunchResult: {
          status: 'failed',
          failure: { code: 'custom_agent_disabled' }
        }
      })
    ).toThrow("Couldn't start the agent (custom_agent_disabled).")
  })

  it('surfaces an admission rejection without dereferencing worktree', () => {
    expect(() =>
      readTaskWorkspaceCreatedResult({
        created: false,
        agentLaunchResult: {
          status: 'rejected',
          requestError: { code: 'untrusted_reference' }
        }
      })
    ).toThrow("Couldn't create the workspace (untrusted_reference).")
  })
})
