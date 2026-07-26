import { describe, expect, it } from 'vitest'
import { normalizeEditedHostEndpoint } from './host-endpoint-edit'

describe('normalizeEditedHostEndpoint', () => {
  it('preserves an unchanged endpoint with an implicit WebSocket port', () => {
    expect(normalizeEditedHostEndpoint('desk.example', 'wss://desk.example')).toEqual({
      ok: true,
      endpoint: 'wss://desk.example'
    })
    expect(normalizeEditedHostEndpoint('desk.example', 'ws://desk.example')).toEqual({
      ok: true,
      endpoint: 'ws://desk.example'
    })
  })

  it('preserves explicit default ports when displayed input is unchanged', () => {
    expect(normalizeEditedHostEndpoint('desk.example:443', 'wss://desk.example:443')).toEqual({
      ok: true,
      endpoint: 'wss://desk.example:443'
    })
    expect(normalizeEditedHostEndpoint('desk.example:80', 'ws://desk.example:80')).toEqual({
      ok: true,
      endpoint: 'ws://desk.example:80'
    })
  })

  it('uses the current scheme default when editing an implicit-port endpoint', () => {
    expect(normalizeEditedHostEndpoint('new.example', 'wss://desk.example')).toEqual({
      ok: true,
      endpoint: 'wss://new.example:443'
    })
    expect(normalizeEditedHostEndpoint('new.example', 'ws://desk.example')).toEqual({
      ok: true,
      endpoint: 'ws://new.example:80'
    })
  })
})
