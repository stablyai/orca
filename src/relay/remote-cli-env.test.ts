import { describe, expect, it } from 'vitest'
import { pickRemoteCliEnv } from './remote-cli-env'

describe('pickRemoteCliEnv', () => {
  it('forwards SSH Orca terminal and worktree context for remote CLI calls', () => {
    expect(
      pickRemoteCliEnv({
        ORCA_TERMINAL_HANDLE: 'term_ssh',
        ORCA_WORKTREE_ID: 'repo::remote',
        ORCA_USER_DATA_PATH: '/tmp/orca',
        PATH: '/usr/bin',
        SECRET_TOKEN: 'nope'
      })
    ).toEqual({
      ORCA_TERMINAL_HANDLE: 'term_ssh',
      ORCA_WORKTREE_ID: 'repo::remote',
      ORCA_USER_DATA_PATH: '/tmp/orca',
      PATH: '/usr/bin'
    })
  })
})
