import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import {
  call,
  clearStructuredHostStub,
  envelope,
  hostCalls,
  installStructuredHostStub,
  runtimeCalls,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'
import { commitStructuredAgentSessionCreate } from './structured-agent-session-create'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { hostTestAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'

describe('fork tab publication barrier', () => {
  it('never publishes an unseeded child tab after an unknown fork', async () => {
    const publish = vi.fn()
    const fork = vi
      .fn()
      .mockResolvedValue({ ok: false, refusal: { code: 'agent_session_operation_unknown' } })
    const result = await commitStructuredAgentSessionCreate({
      runtime: { publishStructuredAgentSessionTab: publish } as unknown as OrcaRuntimeService,
      caller: { callerKey: 'client' },
      activate: true,
      prepared: {
        host: { fork } as unknown as StructuredAgentSessionHost,
        attachParams: hostTestAttachParams(null),
        tab: { workspaceId: 'workspace', agent: 'codex' },
        forkFrom: {
          sessionId: 'parent-session',
          itemId: 'codex:parent:turn:1',
          expectedEpoch: 'epoch',
          expectedRuntimeFence: 1
        }
      }
    })
    expect(result.ok).toBe(false)
    expect(fork).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()
  })

  it('activates the seeded child through the existing tab publisher', async () => {
    const publish = vi.fn().mockResolvedValue(undefined)
    const fork = vi.fn().mockResolvedValue({ ok: true, value: { sessionId: 'child-session' } })
    const attach = vi.fn()
    await commitStructuredAgentSessionCreate({
      runtime: { publishStructuredAgentSessionTab: publish } as unknown as OrcaRuntimeService,
      caller: { callerKey: 'client' },
      activate: true,
      prepared: {
        host: { fork, attach } as unknown as StructuredAgentSessionHost,
        attachParams: hostTestAttachParams(null),
        tab: { workspaceId: 'workspace', agent: 'claude' },
        forkFrom: {
          sessionId: 'parent-session',
          itemId: 'claude:parent:uuid',
          expectedEpoch: 'epoch',
          expectedRuntimeFence: 1
        }
      }
    })
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'workspace',
      sessionId: 'child-session',
      agent: 'claude',
      activate: true
    })
    expect(attach).not.toHaveBeenCalled()
  })
})

/** Who takes the surface. A fork branches the conversation the user is reading, so its tab is
 *  published unactivated; every other create still takes the surface it always did. */
describe('surface ownership of a created chat', () => {
  const WORKTREE = 'id:workspace-1'
  const FORK_FROM = {
    sessionId: 'parent-session',
    itemId: 'codex:parent:turn-1:1',
    expectedEpoch: 'epoch-a',
    expectedRuntimeFence: 1
  }

  beforeEach(() => {
    installStructuredHostStub()
  })

  afterEach(() => {
    clearStructuredHostStub()
  })

  function createParams(fields: { forkFrom?: typeof FORK_FROM }) {
    return {
      envelope: envelope({
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId: SESSION,
          fields: { worktree: WORKTREE, agent: 'codex', ...fields }
        })
      }),
      worktree: WORKTREE,
      agent: 'codex',
      ...fields
    }
  }

  it('publishes a forked chat without activating its tab', async () => {
    const created = await call(
      'agentSession.create',
      createParams({ forkFrom: FORK_FROM }),
      STRUCTURED_CLIENT
    )
    expect(created).toMatchObject({ ok: true, result: { ok: true } })
    expect(hostCalls.fork).toHaveBeenCalledTimes(1)
    expect(hostCalls.attach).not.toHaveBeenCalled()
    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, activate: false })
    )
  })

  it('still activates an ordinary create', async () => {
    const created = await call('agentSession.create', createParams({}), STRUCTURED_CLIENT)
    expect(created).toMatchObject({ ok: true, result: { ok: true } })
    expect(hostCalls.attach).toHaveBeenCalledTimes(1)
    expect(hostCalls.fork).not.toHaveBeenCalled()
    expect(runtimeCalls.publishStructuredAgentSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, activate: true })
    )
  })
})
