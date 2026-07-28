import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
  AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
  MODE_2031_UNSUBSCRIBE_FACT_PROTOCOL_VERSION,
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  supportsMode2031UnsubscribeFact
} from './daemon-protocol-version'

describe('daemon protocol version', () => {
  it('ships the 2031-unsubscribe fact after preflight-cache replacement', () => {
    expect(PROTOCOL_VERSION).toBe(29)
    expect(MODE_2031_UNSUBSCRIBE_FACT_PROTOCOL_VERSION).toBe(29)
    expect(COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION).toBe(27)
    expect(GET_FOREGROUND_PROCESS_PROTOCOL_VERSION).toBe(11)
    expect(AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION).toBe(26)
    expect(AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION).toBe(26)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toEqual(
      Array.from({ length: 28 }, (_, index) => index + 1)
    )
  })

  it('withholds 2031-unsubscribe support from every preserved older daemon', () => {
    // Why (#9993): v28 is what ships today, so a v28 daemon preserved across an app
    // update is the live hazard — it emits '2031-subscribe' with no way to retract it.
    // The boundary must sit at 29, not merely "recent enough".
    expect(supportsMode2031UnsubscribeFact(PROTOCOL_VERSION)).toBe(true)
    expect(supportsMode2031UnsubscribeFact(28)).toBe(false)
    for (const version of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
      expect(supportsMode2031UnsubscribeFact(version)).toBe(false)
    }
  })
})
