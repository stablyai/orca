import { describe, expect, it } from 'vitest'
import { redactedEndpoint } from './endpoint-redaction'

describe('redactedEndpoint', () => {
  it('truncates a plain endpoint to host:port', () => {
    expect(redactedEndpoint('ws://192.168.1.73:7777/rpc')).toBe('192.168.1.73:7777')
    expect(redactedEndpoint('wss://desktop.local:8443')).toBe('desktop.local:8443')
  })

  it('drops userinfo credentials', () => {
    expect(redactedEndpoint('wss://user:pass@host:8443/rpc')).toBe('host:8443')
  })

  it('drops query strings and fragments', () => {
    expect(redactedEndpoint('wss://host?token=secret')).toBe('host')
    expect(redactedEndpoint('wss://host#fragment')).toBe('host')
    expect(redactedEndpoint('wss://user:pass@host?token=secret')).toBe('host')
  })

  it('returns unknown for non-websocket URLs', () => {
    expect(redactedEndpoint('https://example.com')).toBe('unknown')
    expect(redactedEndpoint('not a url')).toBe('unknown')
  })
})
