import { describe, expect, it } from 'vitest'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './types'

describe('foreground-confirmation daemon protocol', () => {
  it('rejects daemons from before the fresh-confirmation RPC', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(19)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(19)
  })
})
