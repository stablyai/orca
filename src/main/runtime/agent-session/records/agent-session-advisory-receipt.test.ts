import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentSessionAdvisoryPolicyFingerprint } from '../../../../shared/agent-session/agent-session-advisory-policy'
import type { AgentSessionAdvisoryReceipt } from '../../../../shared/agent-session/agent-session-advisory-receipt'
import { applyAgentSessionAdvisoryReceipt } from './agent-session-advisory-receipt'

it('preserves owned advisory closure, including unadmitted failure, without accepting foreign evidence', () => {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId: 'session-advisor' })
  )
  record.provider = 'claude'
  record.schemaVersion = 3
  const binding = {
    accountFingerprint: `claude:${'b'.repeat(64)}`,
    model: 'model-fixture',
    effort: 'high'
  }
  record.advisoryPolicy = {
    schema: 2,
    dataScope: 'published',
    sourcePin: 'a'.repeat(40),
    deadlineAt: 1800000120000,
    maxModelCalls: 4,
    binding,
    artifacts: [
      {
        path: 'note',
        text: 'hello',
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      }
    ]
  }
  const receipt: AgentSessionAdvisoryReceipt = {
    version: 1,
    spawnTokenHash: createHash('sha256').update('spawn-owner').digest('hex'),
    invalidated: false,
    turnCompleted: true,
    execution: {
      agent: 'claude',
      sessionId: record.sessionId,
      runtimeFence: 7,
      acquisitionGeneration: 'generation-one',
      observedAt: 1800000000000,
      binding: { ...binding, plan: 'max' },
      bounded: {
        policyFingerprint: agentSessionAdvisoryPolicyFingerprint(record.advisoryPolicy),
        deadlineAt: 1800000120000,
        maxModelCalls: 4,
        modelCalls: 1,
        inputAdmitted: true,
        hooksApplied: true,
        callCounter: 'main-assistant-message-ids'
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
  const captured = applyAgentSessionAdvisoryReceipt(record, write)
  expect(captured.advisoryReceipt).toEqual(receipt)
  for (const changed of [
    { fence: 8 },
    { generation: 'other-generation' },
    { spawnToken: 'other-token' }
  ]) {
    expect(() => applyAgentSessionAdvisoryReceipt(record, { ...write, ...changed })).toThrow(
      'receipt'
    )
  }
  expect(() =>
    applyAgentSessionAdvisoryReceipt(record, {
      ...write,
      receipt: {
        ...receipt,
        execution: {
          ...receipt.execution,
          binding: { ...binding, plan: 'max', accountFingerprint: `claude:${'c'.repeat(64)}` }
        }
      }
    })
  ).toThrow('receipt')
  const failed = {
    ...receipt,
    invalidated: true,
    turnCompleted: false,
    execution: {
      ...receipt.execution,
      binding: null,
      bounded: { ...receipt.execution.bounded, inputAdmitted: false, hooksApplied: false }
    },
    closure: { root: 'exited' as const, tree: 'exited' as const, observedAt: 1800000002000 }
  }
  expect(
    applyAgentSessionAdvisoryReceipt(record, { ...write, receipt: failed }).advisoryReceipt
  ).toEqual(failed)
  const closed = applyAgentSessionAdvisoryReceipt(captured, {
    ...write,
    receipt: { ...receipt, closure: { root: 'exited', tree: 'exited', observedAt: 1800000002000 } }
  })
  expect(applyAgentSessionAdvisoryReceipt(closed, write).advisoryReceipt).toMatchObject({
    closure: { root: 'exited', tree: 'exited', observedAt: 1800000002000 }
  })
  const released = {
    ...captured,
    lease: {
      ...captured.lease,
      claimStatus: 'released' as const,
      runtimeFence: 8,
      ownerProcess: null,
      reservedSpawnToken: null
    }
  }
  const finalWrite = {
    ...write,
    receipt: {
      ...receipt,
      closure: { root: 'exited' as const, tree: 'exited' as const, observedAt: 1800000002000 }
    }
  }
  expect(applyAgentSessionAdvisoryReceipt(released, finalWrite).advisoryReceipt).toMatchObject({
    closure: { root: 'exited', tree: 'exited' }
  })
  for (const replaced of [
    { ...released, lease: { ...released.lease, runtimeFence: 9 } },
    { ...released, lease: { ...record.lease, runtimeFence: 8 } }
  ]) {
    expect(() => applyAgentSessionAdvisoryReceipt(replaced, finalWrite)).toThrow('receipt')
  }
  expect(() => applyAgentSessionAdvisoryReceipt(released, write)).toThrow('receipt')
})
