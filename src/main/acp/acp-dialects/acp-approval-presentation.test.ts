import { describe, expect, it } from 'vitest'
import { approvalNameFromToolCall, approvalRequestPresentation } from './acp-approval-presentation'

const REQUEST = {
  sessionId: 'session-1',
  requestId: 'req-1',
  toolCall: {
    toolCallId: 'call-1',
    name: 'shell',
    status: 'pending',
    content: [
      { type: 'content', content: { type: 'text', text: 'Requesting approval to run: ls' } }
    ]
  },
  options: []
}

const PATTERN = /^Requesting approval to (.+)$/u

describe('approvalRequestPresentation', () => {
  it('returns undefined for other methods', () => {
    expect(approvalRequestPresentation('session/prompt', REQUEST, () => 'x')).toBeUndefined()
  })

  it('returns undefined for unparseable permission params', () => {
    expect(
      approvalRequestPresentation('session/request_permission', { nope: true }, () => 'x')
    ).toBeUndefined()
  })

  it('builds the presentation from the extracted description', () => {
    const result = approvalRequestPresentation('session/request_permission', REQUEST, (request) =>
      approvalNameFromToolCall(PATTERN, request)
    )
    expect(result?.body).toMatchObject({ kind: 'approval', description: 'run: ls' })
  })

  it('caps the description at 512 characters', () => {
    const long = {
      ...REQUEST,
      toolCall: {
        ...REQUEST.toolCall,
        content: [
          {
            type: 'content',
            content: { type: 'text', text: `Requesting approval to ${'x'.repeat(600)}` }
          }
        ]
      }
    }
    const result = approvalRequestPresentation('session/request_permission', long, (request) =>
      approvalNameFromToolCall(PATTERN, request)
    )
    const body = result?.body as { description?: string } | undefined
    expect(body?.description).toHaveLength(512)
  })

  it('skips whitespace-only captures and takes a later real one', () => {
    const spaced = {
      ...REQUEST,
      toolCall: {
        ...REQUEST.toolCall,
        content: [
          { type: 'content', content: { type: 'text', text: 'Requesting approval to   ' } },
          { type: 'content', content: { type: 'text', text: 'Requesting approval to real cmd' } }
        ]
      }
    }
    expect(
      approvalRequestPresentation('session/request_permission', spaced, (request) =>
        approvalNameFromToolCall(PATTERN, request)
      )?.body
    ).toMatchObject({ kind: 'approval', description: 'real cmd' })
  })

  it('does not leak regex lastIndex between calls with a /g pattern', () => {
    const global = /Requesting approval to (.+)/gu
    const first = approvalNameFromToolCall(global, REQUEST as never)
    const second = approvalNameFromToolCall(global, REQUEST as never)
    expect(first).toBe('run: ls')
    expect(second).toBe('run: ls')
  })
})
