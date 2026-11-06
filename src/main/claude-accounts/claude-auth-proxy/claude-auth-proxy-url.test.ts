import { describe, expect, it } from 'vitest'
import { claudeAuthProxySlotPort, isForeignClaudeAuthProxyUrl } from './claude-auth-proxy-url'

describe('claude auth proxy url', () => {
  it('recognizes this process loopback slot and treats every other base URL as a user host', () => {
    expect(claudeAuthProxySlotPort('http://127.0.0.1:4010/p/abc/')).toBe(4010)
    expect(claudeAuthProxySlotPort('http://localhost:4010/p/abc')).toBe(4010)
    expect(claudeAuthProxySlotPort('https://gateway.example')).toBeNull()
    expect(claudeAuthProxySlotPort('http://127.0.0.1:8080/v1')).toBeNull()
    expect(isForeignClaudeAuthProxyUrl('http://127.0.0.1:9/p/desktop/', 4010)).toBe(true)
    expect(isForeignClaudeAuthProxyUrl('http://127.0.0.1:4010/p/local/', 4010)).toBe(false)
    expect(isForeignClaudeAuthProxyUrl('http://127.0.0.1:9/p/desktop/', null)).toBe(true)
    expect(isForeignClaudeAuthProxyUrl('https://gateway.example', null)).toBe(false)
    expect(isForeignClaudeAuthProxyUrl('http://127.0.0.1:8080/v1', 4010)).toBe(false)
  })
})
