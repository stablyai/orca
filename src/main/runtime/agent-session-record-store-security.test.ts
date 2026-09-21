import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
let directory: string

function reserveRequest(): AgentSessionReserveRequest {
  return {
    sessionId: 'session-created',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-created',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/accounts/created' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-created',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'fp-1'
    },
    now: NOW
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-security-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('agent session record store security', () => {
  it.skipIf(process.platform === 'win32')(
    'creates the directory and store owner-only',
    async () => {
      const nestedDirectory = join(directory, 'agent-sessions')
      await chmod(directory, 0o755)
      const store = await AgentSessionRecordStore.open({
        directory: nestedDirectory,
        hostId: 'local'
      })
      await store.reserveOwner(reserveRequest())

      expect((await stat(nestedDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(agentSessionStorePath(nestedDirectory))).mode & 0o777).toBe(0o600)
    }
  )
})
