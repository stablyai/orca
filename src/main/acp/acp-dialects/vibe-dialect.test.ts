import { describe, expect, it } from 'vitest'
import { AcpAgentError } from '../transport/acp-errors'
import { VIBE_ACP_DIALECT } from './vibe-dialect'

describe('Vibe dialect', () => {
  it('has expected structure', () => {
    expect(VIBE_ACP_DIALECT.clientCapabilities).toBeDefined()
    expect(VIBE_ACP_DIALECT.request).toBeDefined()
    expect(VIBE_ACP_DIALECT.promptFailure).toBeDefined()
  })

  it('clientCapabilities includes elicitation.form', () => {
    expect(VIBE_ACP_DIALECT.clientCapabilities?.elicitation?.form).toBeDefined()
  })

  it('request returns undefined for non-permission methods', () => {
    const result = VIBE_ACP_DIALECT.request?.('some/other_method', {})
    expect(result).toBeUndefined()
  })

  it('request returns undefined for malformed permission params', () => {
    const result = VIBE_ACP_DIALECT.request?.('session/request_permission', { nope: true })
    expect(result).toBeUndefined()
  })

  it('request falls back to the toolCallId when no action line matches (vibe-acp 3.1.x sends no content)', () => {
    const result = VIBE_ACP_DIALECT.request?.('session/request_permission', {
      sessionId: 'session-1',
      requestId: 'req-1',
      toolCall: {
        toolCallId: 'shell',
        name: 'shell',
        status: 'pending',
        content: [{ type: 'content', content: { type: 'text', text: 'some other text' } }]
      },
      options: []
    })
    expect(result?.body).toMatchObject({ kind: 'approval', description: 'shell' })
  })

  it('request presents the approval name from session/request_permission', () => {
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
    expect(result?.body).toMatchObject({ kind: 'approval', description: 'run: echo hello' })
  })

  it('request truncates a long approval name to 512 characters', () => {
    const longCommand = `run: ${'x'.repeat(600)}`
    const result = VIBE_ACP_DIALECT.request?.('session/request_permission', {
      sessionId: 'session-1',
      toolCall: {
        toolCallId: 'call-1',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: `Requesting permission to ${longCommand}` }
          }
        ]
      },
      options: []
    })
    const body = result?.body as { description?: string } | undefined
    expect(body?.description).toHaveLength(512)
  })

  it('promptFailure maps cancelled and canceled errors to a cancelled turn', () => {
    for (const message of ['Cancelled by user', 'canceled by the user']) {
      const result = VIBE_ACP_DIALECT.promptFailure?.(new AcpAgentError(-32000, message), 0)
      expect(result?.stopReason).toBe('cancelled')
    }
  })

  it('promptFailure maps the JSON-RPC cancel code to a cancelled turn', () => {
    const result = VIBE_ACP_DIALECT.promptFailure?.(
      new AcpAgentError(-32800, 'Request cancelled'),
      0
    )
    expect(result?.stopReason).toBe('cancelled')
  })

  it('promptFailure leaves other errors to the default handling', () => {
    for (const message of [
      'rate limited',
      'cannot cancel: rate limit exceeded',
      'task cancelled by hook'
    ]) {
      const result = VIBE_ACP_DIALECT.promptFailure?.(new AcpAgentError(-32000, message), 0)
      expect(result).toBeUndefined()
    }
  })
})
