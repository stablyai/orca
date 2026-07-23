import { describe, expect, it, vi } from 'vitest'
import {
  encodeJsonRpcFrame,
  HEADER_LENGTH,
  MAX_MESSAGE_SIZE,
  parseJsonRpcMessage
} from './protocol'
import { RELAY_JSON_MAX_STRUCTURAL_TOKENS } from '../shared/relay-json-admission'

describe('relay JSON frame encoding memory', () => {
  it('preserves accepted JSON bytes', () => {
    const message = {
      jsonrpc: '2.0' as const,
      id: 1,
      result: { escaped: 'line\n🐋', omitted: undefined }
    }

    const frame = encodeJsonRpcFrame(message, 7, 3)

    expect(frame.subarray(HEADER_LENGTH).toString('utf8')).toBe(JSON.stringify(message))
  })

  it('rejects an oversized message before allocating its payload Buffer', () => {
    const message = {
      jsonrpc: '2.0' as const,
      id: 1,
      result: '\n'.repeat(MAX_MESSAGE_SIZE)
    }
    const fromSpy = vi.spyOn(Buffer, 'from')

    try {
      expect(() => encodeJsonRpcFrame(message, 1, 0)).toThrow('Message too large')
      expect(fromSpy).not.toHaveBeenCalled()
    } finally {
      fromSpy.mockRestore()
    }
  })

  it('rejects structurally amplified inbound JSON before parsing', () => {
    const payload = Buffer.from(
      `{"jsonrpc":"2.0","id":1,"method":"x","params":{"values":[${'0,'.repeat(
        RELAY_JSON_MAX_STRUCTURAL_TOKENS
      )}0]}}`
    )
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      expect(() => parseJsonRpcMessage(payload)).toThrow(/JSON structure exceeds/)
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })
})
