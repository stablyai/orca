import { describe, expect, it } from 'vitest'
import { isAgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import {
  attachFingerprintFields,
  reserveRequestFor,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

function params(acpLoadSessionId?: string): AgentSessionAttachParams {
  return {
    envelope: {
      sessionId: 'hermes_chat_1',
      clientOperationId: '1793500710533-124a115871276c8d0b102e7935bc431d',
      expectedRuntimeFence: null,
      payloadFingerprint: 'a'.repeat(64)
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'hermes',
    agent: 'hermes',
    accountHome: { variable: 'HERMES_HOME', path: '/home/dev/.hermes' },
    runtimeKind: 'native',
    ...(acpLoadSessionId ? { acpLoadSessionId } : {})
  }
}

describe('Hermes ACP load seed', () => {
  it('leaves other create fingerprints unchanged', () => {
    expect(attachFingerprintFields(params())).not.toHaveProperty('acpLoadSessionId')
  })

  it('seeds an adopted ACP handle so session/load uses the hook id', () => {
    const reserved = reserveRequestFor({
      sessionId: 'hermes_chat_1',
      params: params(SESSION_ID),
      authority: {
        spawnToken: 'spawn-1',
        claimKeyId: 'claim-1',
        handoffOperationId: null,
        probe: { outcome: 'pid-absent' }
      },
      callerKey: 'caller-1',
      fingerprint: 'a'.repeat(64),
      now: 1_800_000_000_000
    })
    expect(isAgentSessionProviderHandleLink(reserved.adoptedHandleLink)).toBe(true)
    expect(reserved.adoptedHandleLink).toMatchObject({
      origin: 'adopted',
      mintedAtFence: 1,
      handle: { transport: 'acp', agent: 'hermes', nativeId: SESSION_ID }
    })
    expect(attachFingerprintFields(params(SESSION_ID)).acpLoadSessionId).toBe(SESSION_ID)
  })
})
