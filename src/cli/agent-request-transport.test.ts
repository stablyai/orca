import { describe, expect, it } from 'vitest'
import { serializeRemoteRuntimeRpcRequest } from '../shared/remote-runtime-memory-limits'

describe('native answer pin is a transport-local field', () => {
  it('carries a supplied host pin without adding it to the orchestration forwarding envelope', () => {
    const envelope = { orchestrationRequestId: 'existing-operation' }
    const expectedRuntimeSource = { sourceId: 'profile', runtimeId: 'runtime-inspected' }
    const request = JSON.parse(
      serializeRemoteRuntimeRpcRequest({
        requestId: 'request',
        deviceToken: 'test-token',
        method: 'agentSession.respondToApproval',
        params: { exact: true },
        envelope,
        expectedRuntimeSource
      })
    )
    expect(request.expectedRuntimeSource).toEqual(expectedRuntimeSource)
    expect(request.orchestrationRequestId).toBe('existing-operation')
    expect(envelope).not.toHaveProperty('expectedRuntimeSource')
    const ordinary = JSON.parse(
      serializeRemoteRuntimeRpcRequest({
        requestId: 'ordinary',
        deviceToken: 'test-token',
        method: 'orchestration.reply',
        params: { exact: true },
        envelope
      })
    )
    expect(ordinary).not.toHaveProperty('expectedRuntimeSource')
    expect(ordinary.orchestrationRequestId).toBe('existing-operation')
  })
})
