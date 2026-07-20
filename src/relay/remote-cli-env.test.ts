import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_SENDER_CAPABILITY_ENV } from '../shared/orchestration-sender-capability'
import { pickRemoteCliEnv } from './remote-cli-env'

describe('pickRemoteCliEnv', () => {
  it('forwards SSH Orca terminal and worktree context for remote CLI calls', () => {
    expect(
      pickRemoteCliEnv(
        {
          ORCA_TERMINAL_HANDLE: 'term_ssh',
          ORCA_WORKTREE_ID: 'repo::remote',
          ORCA_PANE_KEY: 'pane-1',
          ORCA_WORKSPACE_ID: 'workspace-1',
          ORCA_USER_DATA_PATH: '/tmp/orca',
          PATH: '/usr/bin',
          SECRET_TOKEN: 'nope'
        },
        ['terminal', 'list']
      )
    ).toEqual({
      ORCA_TERMINAL_HANDLE: 'term_ssh',
      ORCA_WORKTREE_ID: 'repo::remote',
      ORCA_PANE_KEY: 'pane-1',
      ORCA_WORKSPACE_ID: 'workspace-1',
      ORCA_USER_DATA_PATH: '/tmp/orca',
      PATH: '/usr/bin'
    })
  })

  it.each([
    ['legacy worker_done', ['orchestration', 'send', '--type', 'worker_done']],
    ['legacy heartbeat', ['orchestration', 'send', '--type=heartbeat']],
    [
      'global boolean before the command',
      ['--json', 'orchestration', 'send', '--type=worker_done']
    ],
    [
      'global boolean between command segments',
      ['orchestration', '--json', 'send', '--type', 'heartbeat']
    ],
    [
      'value flag before the command',
      ['--environment', 'remote', 'orchestration', 'send', '--type', 'worker_done']
    ],
    [
      'value flag between command segments',
      ['orchestration', '--subject', 'Alive', 'send', '--type', 'heartbeat']
    ],
    [
      'equals value flags before the command',
      ['--environment=remote', 'orchestration', 'send', '--type=worker_done']
    ],
    [
      'equals value flags between command segments',
      ['orchestration', '--subject=Done', 'send', '--type=heartbeat']
    ]
  ])('forwards the sender capability for %s', (_label, argv) => {
    const capability = randomUUID()
    expect(
      pickRemoteCliEnv(
        {
          ORCA_TERMINAL_HANDLE: 'term_ssh',
          [ORCHESTRATION_SENDER_CAPABILITY_ENV]: capability,
          UNRELATED_SECRET: 'nope'
        },
        argv
      )
    ).toEqual({
      ORCA_TERMINAL_HANDLE: 'term_ssh',
      [ORCHESTRATION_SENDER_CAPABILITY_ENV]: capability
    })
  })

  it.each([
    ['ordinary orchestration', ['orchestration', 'send', '--subject', 'hello']],
    ['different command', ['terminal', 'list']],
    ['foreign type', ['orchestration', 'send', '--type', 'status']],
    [
      'command words in flag values',
      ['terminal', 'send', '--text', 'orchestration', '--for', 'send', '--type', 'worker_done']
    ],
    [
      'lifecycle type in positional text',
      ['orchestration', 'send', 'worker_done', '--type', 'worker_done']
    ],
    ['missing type', ['orchestration', 'send', '--subject', 'worker_done']],
    ['type without a value', ['orchestration', 'send', '--type']],
    ['malformed value flag', ['orchestration', 'send', '--type=worker_done', '--subject']],
    ['unknown flag', ['--bogus', 'orchestration', 'send', '--type=worker_done']],
    ['help mode', ['orchestration', '--help', 'send', '--type=worker_done']],
    ['worker_done lookalike', ['orchestration', 'send', '--type=worker_done_extra']],
    ['heartbeat lookalike', ['orchestration', 'send', '--type', 'heartbeat-ish']],
    [
      'later non-lifecycle type override',
      ['orchestration', 'send', '--type=worker_done', '--type', 'status']
    ]
  ])('strips lifecycle authority from %s transport', (_label, argv) => {
    const capability = randomUUID()
    expect(
      pickRemoteCliEnv(
        {
          ORCA_TERMINAL_HANDLE: 'term_ssh',
          [ORCHESTRATION_SENDER_CAPABILITY_ENV]: capability
        },
        argv
      )
    ).toEqual({ ORCA_TERMINAL_HANDLE: 'term_ssh' })
  })
})
