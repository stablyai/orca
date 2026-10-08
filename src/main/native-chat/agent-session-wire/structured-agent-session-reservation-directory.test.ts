import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { reserveRequestFor, type AgentSessionAttachParams } from './structured-agent-session-attach'

const params: AgentSessionAttachParams = {
  envelope: {
    sessionId: 'chat-one',
    clientOperationId: 'op-one',
    expectedRuntimeFence: null,
    payloadFingerprint: 'fingerprint'
  },
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
    workspaceKind: 'folder'
  },
  provider: 'claude',
  agent: 'claude',
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/host/account' },
  runtimeKind: 'native'
}

describe('host-resolved directory in the attach reservation', () => {
  it('carries the folder into the same required reservation as the record', () => {
    const request = reserveRequestFor({
      sessionId: params.envelope.sessionId,
      params,
      authority: {
        spawnToken: 'spawn-one',
        claimKeyId: 'claim-one',
        handoffOperationId: null,
        probe: { outcome: 'reservation-unused' },
        launchDirectory: '/host/floating-folder'
      },
      callerKey: 'client-one',
      fingerprint: 'fingerprint',
      now: 123
    })

    expect(request.launchDirectory).toBe('/host/floating-folder')
    expect(request.location.workspaceId).toBe(FLOATING_TERMINAL_WORKTREE_ID)
  })

  it('carries where a fork was cut from, which is all a Codex fork has to start from', () => {
    const forkedFrom = {
      sessionId: 'codex_parent_chat',
      itemId: 'codex:thread-parent:turn-1:1',
      providerSessionId: 'thread-parent',
      forkPoint: 'turn-1'
    }
    const authority = {
      spawnToken: 'spawn-one',
      claimKeyId: 'claim-one',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' }
    } as const
    const reserve = (attach: AgentSessionAttachParams) =>
      reserveRequestFor({
        sessionId: attach.envelope.sessionId,
        params: attach,
        authority,
        callerKey: 'client-one',
        fingerprint: 'fingerprint',
        now: 123
      })

    expect(reserve({ ...params, forkedFrom }).forkedFrom).toEqual(forkedFrom)
    expect(reserve(params)).not.toHaveProperty('forkedFrom')
  })
})
