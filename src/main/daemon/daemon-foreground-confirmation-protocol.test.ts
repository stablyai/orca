import { describe, expect, it } from 'vitest'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './types'

describe('foreground-confirmation daemon protocol', () => {
  it('rejects daemons from before the fresh-confirmation RPC', () => {
    expect(PROTOCOL_VERSION).toBe(22)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(19)
    // Why: v21 lacks full-session teardown, so the client must replace it
    // instead of accepting a legacy daemon that can strand descendants.
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(21)
  })
})
