import { describe, expect, it } from 'vitest'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './types'

describe('foreground-confirmation daemon protocol', () => {
  it('rejects daemons from before the fresh-confirmation RPC', () => {
    expect(PROTOCOL_VERSION).toBe(36)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(19)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(22)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(23)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(24)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(25)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(26)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(27)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(28)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(29)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(30)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(31)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(32)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(33)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(34)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(35)
  })
})
