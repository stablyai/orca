import { describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION } from '../../shared/agent-session-host-authority'
import { SshPtyProvider } from './ssh-pty-provider'

describe('SSH claimed PTY incarnation validation', () => {
  it('retires a created owner with an invalid incarnation identity', async () => {
    const claim = {
      digestVersion: 1 as const,
      keyId: 'key',
      identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      agent: 'codex' as const
    }
    const surface = {
      worktreeId: 'worktree',
      tabId: 'tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      terminalHandle: 'term_claimed'
    }
    const request = vi.fn(async (method: string) => {
      if (method === 'pty.getCapabilities') {
        return { agentSessionClaimVersion: AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION }
      }
      if (method === 'pty.spawn') {
        return {
          id: 'pty-invalid-incarnation',
          incarnationId: 'i'.repeat(129),
          agentSessionEnsure: {
            disposition: 'created',
            owner: {
              claim,
              generation: 'generation-invalid-incarnation',
              phase: 'live',
              ptyId: 'pty-invalid-incarnation',
              surface
            }
          }
        }
      }
      return undefined
    })
    const provider = new SshPtyProvider('conn-1', {
      request,
      notify: vi.fn(),
      onNotification: vi.fn()
    } as never)

    await expect(
      provider.spawn({ cols: 80, rows: 24, agentSessionEnsure: { claim, surface } })
    ).rejects.toThrow('agent_session_ownership_unknown')
    expect(request).toHaveBeenCalledWith('pty.shutdown', {
      id: 'pty-invalid-incarnation',
      immediate: true
    })
  })
})
