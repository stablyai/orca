import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { handoffStructuredSessionToNative } from './structured-agent-session-handoff-reverse'
import type { StructuredAgentSessionHandoffFlowContext } from './structured-agent-session-handoff-types'

const OPERATION_ID = 'operation-1'
const SESSION_ID = 'session-1'

vi.mock('../../runtime/agent-session-handoff-record-transitions', () => ({
  abandonStoredAgentSessionHandoffAttempt: vi.fn(async () => undefined),
  reserveStoredAgentSessionHandoffOwner: vi.fn(async () => record()),
  rollbackStoredAgentSessionHandoffPreparation: vi.fn(async () => undefined),
  stopStoredAgentSessionOwnerForHandoff: vi.fn(async () => record())
}))

function record(): AgentSessionRecord {
  return {
    sessionId: SESSION_ID,
    provider: 'claude',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    lease: {
      runtimeFence: 3,
      handoffStage: 'old-owner-stopped',
      handoffOperationId: OPERATION_ID
    }
  } as unknown as AgentSessionRecord
}

function contextWith(
  revealNativeSession: () => Promise<void>,
  statuses: AgentSessionHandoffStatus[]
): StructuredAgentSessionHandoffFlowContext {
  return {
    deps: {
      store: {} as never,
      claimKeyId: 'key-1',
      now: () => 1_800_000_000_000,
      importTuiHistory: vi.fn(async () => undefined),
      acquireNative: vi.fn(async () => record()),
      transport: { revealNativeSession }
    } as never,
    owner: () => undefined,
    retainOwner: vi.fn(),
    releaseOwner: vi.fn(),
    setStatus: (_sessionId, status) => statuses.push(status),
    enterPreparing: vi.fn(async () => undefined),
    publishStage: vi.fn(),
    requireRecord: () => record()
  }
}

// Why this ordering matters: releaseOwner has already run by the time the reveal fires,
// so a reveal that rejects before the status flip leaves the session released but never
// marked native — a stuck chat with no owner on either side.
describe('handoffStructuredSessionToNative', () => {
  it('marks the session native before revealing it', async () => {
    const statuses: AgentSessionHandoffStatus[] = []
    const order: string[] = []
    const context = contextWith(async () => {
      order.push('reveal')
    }, statuses)
    const setStatus = context.setStatus
    context.setStatus = (sessionId, status) => {
      order.push('status')
      setStatus(sessionId, status)
    }

    await handoffStructuredSessionToNative(
      context,
      { envelope: { sessionId: SESSION_ID, clientOperationId: OPERATION_ID } } as never,
      true
    )

    expect(order).toEqual(['status', 'reveal'])
    expect(statuses.at(-1)).toMatchObject({ owner: 'native', direction: null, phase: 'idle' })
  })

  it('still leaves the session marked native when the reveal rejects', async () => {
    const statuses: AgentSessionHandoffStatus[] = []
    const context = contextWith(async () => {
      throw new Error('publish failed')
    }, statuses)

    await expect(
      handoffStructuredSessionToNative(
        context,
        { envelope: { sessionId: SESSION_ID, clientOperationId: OPERATION_ID } } as never,
        true
      )
    ).rejects.toThrow('publish failed')

    expect(statuses.at(-1)).toMatchObject({ owner: 'native' })
  })
})
