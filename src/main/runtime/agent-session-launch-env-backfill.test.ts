import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const SESSION = 'session-launch-env'
let directory: string

function request(overrides: Partial<AgentSessionReserveRequest> = {}): AgentSessionReserveRequest {
  return {
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'fp-1'
    },
    now: NOW,
    ...overrides
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-launch-env-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('legacy agent session launch environment', () => {
  it('durably pins the first environment resolved by a current reservation', async () => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await store.reserveOwner(request())
    await store.reserveOwner(
      request({
        expectedFence: 1,
        spawnToken: 'spawn-b',
        launchEnv: { ANTHROPIC_AUTH_TOKEN: 'pinned-token' },
        operation: {
          callerKey: 'client-1',
          operationId: `${NOW}-00000000000000000000000000000002`,
          fingerprint: 'fp-2'
        }
      })
    )

    const reopened = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    expect(reopened.getRecord(SESSION)?.launchEnv).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'pinned-token'
    })
  })

  it('rejects an environment that could not be reloaded before writing it', async () => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    const launchEnv = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`KEY_${index}`, 'value'])
    )

    await expect(store.reserveOwner(request({ launchEnv }))).rejects.toThrow(
      'agent_session_launch_env_invalid'
    )
    expect(store.getRecord(SESSION)).toBeNull()
  })

  it('rejects an overlong environment key before writing it', async () => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })

    await expect(
      store.reserveOwner(request({ launchEnv: { ['K'.repeat(513)]: 'value' } }))
    ).rejects.toThrow('agent_session_launch_env_invalid')
    expect(store.getRecord(SESSION)).toBeNull()
  })
})
