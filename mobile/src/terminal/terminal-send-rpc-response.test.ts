import { describe, expect, it } from 'vitest'
import { isTerminalSendResultAccepted } from './terminal-send-rpc-response'

describe('terminal send RPC response', () => {
  it('Given accepted terminal send result When checked Then reports success', () => {
    // Given
    const result = { send: { handle: 'terminal-1', accepted: true, bytesWritten: 1 } }

    // When / Then
    expect(isTerminalSendResultAccepted(result)).toBe(true)
  })

  it('Given rejected terminal send result When checked Then reports failure', () => {
    // Given
    const result = { send: { handle: 'terminal-1', accepted: false, bytesWritten: 0 } }

    // When / Then
    expect(isTerminalSendResultAccepted(result)).toBe(false)
  })

  it('Given absent or malformed terminal send result When checked Then reports failure', () => {
    // Given: a refusal envelope carries no result at all, and a fulfilled one may carry the
    // wrong shape.
    const absent = undefined
    const malformed = {}

    // When / Then
    expect(isTerminalSendResultAccepted(absent)).toBe(false)
    expect(isTerminalSendResultAccepted(malformed)).toBe(false)
  })
})
