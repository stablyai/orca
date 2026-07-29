import { describe, expect, it } from 'vitest'
import { displayHostEndpoint } from './host-endpoint'
import { resolveHostEndpointEdit } from './host-endpoint-edit'

function persistedAfterEdit(stored: string, input = displayHostEndpoint(stored)) {
  const edit = resolveHostEndpointEdit(stored, input)
  return edit.addressChanged && edit.normalizedEndpoint.ok
    ? edit.normalizedEndpoint.endpoint
    : stored
}

describe('resolveHostEndpointEdit', () => {
  it.each([
    ['implicit secure DNS proxy', 'wss://desk.example.com'],
    ['explicit secure default', 'wss://desk.example.com:443'],
    ['explicit secure custom', 'wss://desk.example.com:8443'],
    ['implicit secure IPv6 proxy', 'wss://[2001:db8::1]'],
    ['explicit secure IPv6 default', 'wss://[2001:db8::1]:443'],
    ['implicit LAN websocket', 'ws://desk.local'],
    ['explicit websocket default', 'ws://desk.local:80'],
    ['explicit websocket custom', 'ws://desk.local:6768'],
    ['secure path-routed proxy', 'wss://desk.example.com/orca'],
    ['secure query-routed proxy', 'wss://desk.example.com/orca?route=runtime'],
    ['legacy bare hostname', 'desk.local'],
    ['legacy bare host and port', 'desk.local:7777'],
    ['legacy unparsable endpoint', 'not-a-url']
  ])('preserves an untouched %s endpoint', (_label, stored) => {
    const edit = resolveHostEndpointEdit(stored, displayHostEndpoint(stored))

    expect(edit.addressChanged).toBe(false)
    expect(persistedAfterEdit(stored)).toBe(stored)
  })

  it.each([
    ['wss://old.example.com', 'new.example.com', 'wss://new.example.com:443'],
    ['wss://old.example.com:8443', 'new.example.com', 'wss://new.example.com:8443'],
    ['ws://old.local', 'new.local', 'ws://new.local:6768'],
    ['ws://old.local:80', 'new.local', 'ws://new.local:80'],
    ['wss://[2001:db8::1]', '[2001:db8::2]', 'wss://[2001:db8::2]:443']
  ])('uses the current endpoint semantics for an address edit', (stored, input, expected) => {
    const edit = resolveHostEndpointEdit(stored, input)

    expect(edit).toEqual({
      addressChanged: true,
      normalizedEndpoint: { ok: true, endpoint: expected }
    })
  })

  it('stays stable through repeated name-only edits', () => {
    const stored = 'wss://desk.example.com/orca?route=runtime'
    const once = persistedAfterEdit(stored)

    expect(once).toBe(stored)
    expect(persistedAfterEdit(once)).toBe(stored)
  })
})
