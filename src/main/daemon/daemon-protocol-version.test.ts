import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
  AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
  HISTORY_SEED_TRANSFER_PROTOCOL_VERSION,
  MODE_2031_UNSUBSCRIBE_FACT_PROTOCOL_VERSION,
  SNAPSHOT_SERIALIZER_FIDELITY_DAEMON_PROTOCOL_VERSION,
  STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION,
  WSL_POSIX_CWD_DAEMON_PROTOCOL_VERSION,
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  supportsMode2031UnsubscribeFact
} from './daemon-protocol-version'

describe('daemon protocol version', () => {
  it('ships bounded history transfer after the 2031-unsubscribe fact', () => {
    expect(PROTOCOL_VERSION).toBe(33)
    expect(WSL_POSIX_CWD_DAEMON_PROTOCOL_VERSION).toBe(33)
    expect(SNAPSHOT_SERIALIZER_FIDELITY_DAEMON_PROTOCOL_VERSION).toBe(32)
    expect(STABLE_PANE_ATTACH_ONLY_DAEMON_PROTOCOL_VERSION).toBe(31)
    expect(HISTORY_SEED_TRANSFER_PROTOCOL_VERSION).toBe(30)
    expect(MODE_2031_UNSUBSCRIBE_FACT_PROTOCOL_VERSION).toBe(29)
    expect(COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION).toBe(27)
    expect(GET_FOREGROUND_PROCESS_PROTOCOL_VERSION).toBe(11)
    expect(AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION).toBe(26)
    expect(AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION).toBe(26)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1)
    )
  })

  it('withholds 2031-unsubscribe support only before its v29 boundary', () => {
    // Why (#9993): v28 is what ships today, so a v28 daemon preserved across an app
    // update is the live hazard — it emits '2031-subscribe' with no way to retract it.
    // The boundary must sit at 29, not merely "recent enough".
    expect(supportsMode2031UnsubscribeFact(PROTOCOL_VERSION)).toBe(true)
    expect(supportsMode2031UnsubscribeFact(29)).toBe(true)
    expect(supportsMode2031UnsubscribeFact(28)).toBe(false)
    for (const version of PREVIOUS_DAEMON_PROTOCOL_VERSIONS.filter((version) => version < 29)) {
      expect(supportsMode2031UnsubscribeFact(version)).toBe(false)
    }
  })
})
