import { describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION } from '../../shared/agent-session-host-authority'
import { SshAgentSessionCapabilities } from './ssh-agent-session-capabilities'

describe('SshAgentSessionCapabilities', () => {
  it('does not classify a transient claim probe failure as an old relay', async () => {
    const probeError = new Error('SSH transport interrupted')
    const request = vi.fn().mockRejectedValueOnce(probeError).mockResolvedValueOnce({
      agentSessionClaimVersion: AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION
    })
    const capabilities = new SshAgentSessionCapabilities({ request } as never)

    await expect(capabilities.supportsClaims()).rejects.toBe(probeError)
    await expect(capabilities.supportsClaims()).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })
})
