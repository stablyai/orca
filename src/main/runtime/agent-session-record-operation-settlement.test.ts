import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentSessionRecordStore } from './agent-session-record-store'

const NOW = 1_800_000_000_000
const OPERATION_ID = `${NOW}-${'0'.repeat(32)}`
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-operation-settlement-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('agent session record operation settlement', () => {
  it('never downgrades a terminal mutation outcome during concurrent error recovery', async () => {
    const operation = { callerKey: 'client-1', operationId: OPERATION_ID, fingerprint: 'fp-1' }
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await store.reserveOwner({
      sessionId: 'session-alpha',
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
      runtimeKind: 'native',
      expectedFence: null,
      spawnToken: 'spawn-a',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'indeterminate', reason: 'no answer' },
      operation,
      now: NOW
    })

    await expect(
      store.recordOperationOutcomeIfCurrent({
        callerKey: operation.callerKey,
        operationId: operation.operationId,
        outcome: { status: 'succeeded', sessionId: 'session-alpha' },
        current: 'unsettled'
      })
    ).resolves.toBe(true)
    await expect(
      store.recordOperationOutcomeIfCurrent({
        callerKey: operation.callerKey,
        operationId: operation.operationId,
        outcome: { status: 'unknown' },
        current: 'pending'
      })
    ).resolves.toBe(false)
    expect(store.listOperationRows().at(-1)?.outcome).toEqual({
      status: 'succeeded',
      sessionId: 'session-alpha'
    })
  })
})
