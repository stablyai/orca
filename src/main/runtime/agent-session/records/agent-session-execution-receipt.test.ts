import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentSessionExecutionPolicyFingerprint } from '../../../../shared/agent-session/agent-session-execution-policy'
import { applyAgentSessionExecutionReceipt } from './agent-session-execution-receipt'

it('retains exact-owner execution evidence after close and refuses foreign generations, fences or policies', () => {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId: 'session-bounded' })
  )
  record.provider = 'codex'
  record.schemaVersion = 4
  record.location = {
    executionHostId: 'local',
    wslDistro: null,
    workspaceKind: 'folder',
    workspaceId: 'folder-one'
  }
  record.executionPolicy = {
    schema: 1,
    sourcePin: 'a'.repeat(40),
    accountFingerprint: `codex:${'b'.repeat(64)}`,
    model: 'model-one',
    effort: 'low',
    access: 'read-only',
    deadlineAt: 1800000120000
  }
  const receipt = {
    version: 1 as const,
    spawnTokenHash: createHash('sha256').update('spawn-owner').digest('hex'),
    invalidated: false,
    turnCompleted: true,
    execution: {
      version: 1 as const,
      agent: 'codex' as const,
      modelProvider: 'openai' as const,
      sessionId: 'session-bounded',
      runtimeFence: 7,
      acquisitionGeneration: 'generation-one',
      observedAt: 1800000000000,
      cwd: '/work/repo',
      model: 'model-one',
      effort: 'low',
      account: { type: 'chatgpt' as const, fingerprint: `codex:${'b'.repeat(64)}`, plan: 'pro' },
      permissions: {
        activeProfile: { id: 'orca-bounded-session-bounded' },
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly' as const, networkAccess: false as const }
      },
      bounded: {
        policyFingerprint: agentSessionExecutionPolicyFingerprint(record.executionPolicy),
        deadlineAt: 1800000120000,
        toolsIsolated: true,
        inputAdmitted: true,
        workspaceRootsSource: 'thread-open' as const
      }
    }
  }
  const write = {
    sessionId: record.sessionId,
    fence: 7,
    generation: 'generation-one',
    spawnToken: 'spawn-owner',
    receipt
  }
  const captured = applyAgentSessionExecutionReceipt(record, write)
  expect(captured.executionReceipt).toEqual(receipt)
  const closed = {
    ...captured,
    lease: {
      ...captured.lease,
      claimStatus: 'released' as const,
      ownerProcess: null,
      reservedSpawnToken: null
    }
  }
  expect(
    applyAgentSessionExecutionReceipt(closed, {
      ...write,
      receipt: {
        ...receipt,
        closure: { root: 'exited', tree: 'exited', observedAt: 1800000002000 }
      }
    }).executionReceipt
  ).toMatchObject({ closure: { root: 'exited', tree: 'exited' } })
  for (const change of [
    { fence: 8 },
    { generation: 'generation-other' },
    { spawnToken: 'other' }
  ]) {
    expect(() => applyAgentSessionExecutionReceipt(record, { ...write, ...change })).toThrow(
      'execution receipt'
    )
  }
  expect(() =>
    applyAgentSessionExecutionReceipt(
      { ...record, executionPolicy: { ...record.executionPolicy!, sourcePin: 'c'.repeat(40) } },
      write
    )
  ).toThrow('execution receipt')
})
