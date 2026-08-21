import { describe, expect, it } from 'vitest'
import { pickRemoteCliEnv } from './remote-cli-env'

describe('pickRemoteCliEnv', () => {
  it('forwards SSH MCode terminal and worktree context for remote CLI calls', () => {
    expect(
      pickRemoteCliEnv({
        MCODE_TERMINAL_HANDLE: 'term_ssh',
        MCODE_WORKTREE_ID: 'repo::remote',
        MCODE_PANE_KEY: 'pane-1',
        MCODE_AGENT_LAUNCH_TOKEN: 'launch-secret',
        MCODE_WORKSPACE_ID: 'workspace-1',
        MCODE_USER_DATA_PATH: '/tmp/mcode',
        PATH: '/usr/bin',
        SECRET_TOKEN: 'nope'
      })
    ).toEqual({
      MCODE_TERMINAL_HANDLE: 'term_ssh',
      MCODE_WORKTREE_ID: 'repo::remote',
      MCODE_PANE_KEY: 'pane-1',
      MCODE_AGENT_LAUNCH_TOKEN: 'launch-secret',
      MCODE_WORKSPACE_ID: 'workspace-1',
      MCODE_USER_DATA_PATH: '/tmp/mcode',
      PATH: '/usr/bin'
    })
  })
})
