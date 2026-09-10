import { describe, expect, it, vi } from 'vitest'
import {
  decideWorkerStartMode,
  resolveWorkerStartModeOnHost
} from './orchestration-worker-start-mode'

const mode = decideWorkerStartMode({
  params: { agent: 'claude' },
  settings: {
    experimentalNativeChat: true,
    experimentalStructuredNativeChat: true,
    openAgentTabsInChatByDefault: true
  }
})

describe('host support evidence', () => {
  it('distinguishes an unanswered host from an explicit refusal without creating a session', async () => {
    const getStructuredAgentSessionCreateSupport = vi
      .fn()
      .mockRejectedValue(new Error('disconnected'))
    const runtime = { getStructuredAgentSessionCreateSupport }
    const unknown = await resolveWorkerStartModeOnHost(runtime, mode, 'workspace-1', 'claude')
    expect(unknown).toMatchObject({
      mode: 'terminal',
      preferred: 'structured',
      reason: 'structured_support_unknown'
    })
    expect(unknown.detail).toContain('has not established')
    expect(getStructuredAgentSessionCreateSupport).toHaveBeenCalledWith('id:workspace-1', 'claude')
    getStructuredAgentSessionCreateSupport.mockResolvedValue({ supported: false })
    const refusal = await resolveWorkerStartModeOnHost(runtime, mode, 'workspace-1', 'claude')
    expect(refusal.reason).toBe('structured_unsupported_on_host')
    expect(refusal.detail).toContain('cannot create')
  })
})
