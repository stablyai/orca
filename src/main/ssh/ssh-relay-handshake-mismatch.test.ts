import { describe, expect, it } from 'vitest'
import { buildRelayHandshakeRefusalError } from './ssh-relay-handshake-mismatch'
import {
  RelayVersionMismatchError,
  RELAY_EXIT_CODE_VERSION_MISMATCH
} from './ssh-relay-version-mismatch-error'
import {
  RelayCredentialMismatchError,
  RELAY_EXIT_CODE_CREDENTIAL_MISMATCH
} from './ssh-relay-credential-mismatch-error'

describe('buildRelayHandshakeRefusalError', () => {
  // The bridge's mismatch line now carries `daemonProtocol=` and `ours=` after the version, so a
  // `daemon=` capture that merely stops at `;` swallows the separating comma into the version.
  it('names the daemon version without the comma that follows it', () => {
    const error = buildRelayHandshakeRefusalError(
      RELAY_EXIT_CODE_VERSION_MISMATCH,
      '[relay-connect] Handshake mismatch: expected=0.1.0+aaa, daemon=0.1.0+bbb, ' +
        'daemonProtocol=6, ours=1; exiting 42\n'
    )
    expect(error).toBeInstanceOf(RelayVersionMismatchError)
    expect(error).toMatchObject({ expected: '0.1.0+aaa', got: '0.1.0+bbb' })
  })

  // A relay from before the protocol fields still emits the short form.
  it('still reads the pre-negotiation form of the line', () => {
    const error = buildRelayHandshakeRefusalError(
      RELAY_EXIT_CODE_VERSION_MISMATCH,
      '[relay-connect] Handshake mismatch: expected=0.1.0+aaa, daemon=0.1.0+bbb; exiting 42\n'
    )
    expect(error).toMatchObject({ expected: '0.1.0+aaa', got: '0.1.0+bbb' })
  })

  it('reports an unparseable mismatch line without inventing versions', () => {
    const error = buildRelayHandshakeRefusalError(RELAY_EXIT_CODE_VERSION_MISMATCH, 'nothing here')
    expect(error).toMatchObject({ expected: undefined, got: undefined })
  })

  it('keeps a refused credential distinct from a version skew', () => {
    expect(
      buildRelayHandshakeRefusalError(RELAY_EXIT_CODE_CREDENTIAL_MISMATCH, 'refused')
    ).toBeInstanceOf(RelayCredentialMismatchError)
  })

  it('returns nothing for an exit code that encodes no refusal', () => {
    expect(buildRelayHandshakeRefusalError(1, 'crashed')).toBeNull()
  })
})
