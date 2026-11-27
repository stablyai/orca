import { describe, expect, it } from 'vitest'
import { AcpAgentError } from '../transport/acp-errors'
import { VIBE_ACP_DIALECT } from './vibe-dialect'

describe('Vibe dialect', () => {
  it('has expected structure', () => {
    // Verify the dialect exports exist and have expected types
    expect(VIBE_ACP_DIALECT.clientCapabilities).toBeDefined()
    expect(VIBE_ACP_DIALECT.normalizeToolUpdate).toBeDefined()
    expect(VIBE_ACP_DIALECT.toolName).toBeDefined()
    expect(VIBE_ACP_DIALECT.request).toBeDefined()
    expect(VIBE_ACP_DIALECT.settleRequest).toBeDefined()
    expect(VIBE_ACP_DIALECT.promptFailure).toBeDefined()
  })

  it('clientCapabilities includes elicitation.form', () => {
    expect(VIBE_ACP_DIALECT.clientCapabilities?.elicitation?.form).toBeDefined()
  })

  it('normalizeToolUpdate returns the update unchanged', () => {
    const update = { toolCallId: 'test', status: 'in_progress' }
    const result = VIBE_ACP_DIALECT.normalizeToolUpdate!(update)
    expect(result).toEqual(update)
  })

  it('toolName returns undefined for vibe', () => {
    const update = { toolCallId: 'test', name: 'shell' }
    const result = VIBE_ACP_DIALECT.toolName!(update)
    expect(result).toBeUndefined()
  })

  it('request returns undefined for non-permission methods', () => {
    const result = VIBE_ACP_DIALECT.request?.('some/other_method', {})
    expect(result).toBeUndefined()
  })

  it('request handles session/request_permission', () => {
    const result = VIBE_ACP_DIALECT.request?.('session/request_permission', {
      sessionId: 'session-1',
      requestId: 'req-1',
      toolCall: {
        toolCallId: 'call-1',
        name: 'shell',
        status: 'pending',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Requesting approval to run: echo hello' }
          }
        ]
      },
      options: []
    })
    // Function should not throw, may return undefined if format doesn't match
    expect(result).toBeDefined()
  })

  it('settleRequest returns undefined for vibe', () => {
    const result = VIBE_ACP_DIALECT.settleRequest?.('session/request_permission', {})
    expect(result).toBeUndefined()
  })

  it('promptFailure handles cancelled errors', () => {
    const result = VIBE_ACP_DIALECT.promptFailure?.(
      new AcpAgentError(-32000, 'Cancelled by user'),
      0
    )
    expect(result?.stopReason).toBe('cancelled')
  })
})
