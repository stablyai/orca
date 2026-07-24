import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
  AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION
} from './daemon-protocol-version'

describe('daemon protocol version', () => {
  it('ships preflight-cache replacement after completion inspection', () => {
    expect(PROTOCOL_VERSION).toBe(28)
    expect(COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION).toBe(27)
    expect(AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION).toBe(26)
    expect(AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION).toBe(26)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toEqual(
      Array.from({ length: 27 }, (_, index) => index + 1)
    )
  })
})
