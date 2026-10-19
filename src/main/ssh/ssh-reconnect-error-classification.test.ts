import { describe, it, expect } from 'vitest'
import {
  isTransientError,
  isDefiniteSystemSshHostFailure,
  isTransientReconnectError,
  isSystemSshFallbackError,
  isGssapiSystemSshFallbackCandidate,
  isAuthError,
  isAgentFallbackError
} from './ssh-reconnect-error-classification'
import { HostKeyVerificationError } from './ssh-host-key-decision'

describe('isTransientReconnectError', () => {
  it('treats the system SSH connect timeout as recoverable', () => {
    const err = new Error('System SSH connection timed out')
    // Guards the split: widening isTransientError would spend 5 connect() attempts on this.
    expect(isTransientError(err)).toBe(false)
    expect(isTransientReconnectError(err)).toBe(true)
  })

  it('treats the bounded ssh2 authentication watchdog as recoverable', () => {
    const err = Object.assign(new Error('Timed out while waiting for SSH authentication'), {
      level: 'client-timeout'
    })

    expect(isTransientReconnectError(err)).toBe(true)
  })

  it.each([
    'System SSH probe failed (exit 255).',
    'System SSH probe failed (exit 255). stderr: ssh: connect to host box port 22: Connection refused',
    'System SSH probe failed (exit 255). stderr: ssh: connect to host box port 22: No route to host',
    'System SSH probe failed (exit 255). stderr: ssh: connect to host box port 22: Network is unreachable',
    'System SSH probe failed (exit 255). stderr: kex_exchange_identification: read: Connection reset by peer',
    'System SSH probe failed (exit 255). stderr: ssh: Could not resolve hostname box: Name or service not known',
    'System SSH probe failed (exit 255). stderr: ssh_exchange_identification: read: Connection reset by peer',
    'System SSH probe failed (exit 255). stderr: ssh_exchange_identification: Connection closed by remote host',
    'System SSH probe failed (exit 255). stderr: Connection closed by remote host',
    'System SSH probe failed (exit 255). stderr: Lost connection',
    'System SSH probe failed (exit 255). stderr: Remote end closed connection'
  ])('treats OpenSSH network prose as recoverable: %s', (message) => {
    expect(isTransientReconnectError(new Error(message))).toBe(true)
  })

  it('keeps the bare probe failure narrow to the reconnect classifier', () => {
    const err = new Error('System SSH probe failed (exit 255).')
    expect(isTransientError(err)).toBe(false)
    expect(isTransientReconnectError(err)).toBe(true)
  })

  // A server-side rejection prints the same verb without "remote"; retrying it forever would hide a
  // real misconfiguration behind the ladder.
  it('keeps a bare "Connection closed by <host> port <n>" permanent', () => {
    expect(
      isTransientReconnectError(
        new Error(
          'System SSH probe failed (exit 255). stderr: Connection closed by 10.0.0.4 port 22'
        )
      )
    ).toBe(false)
  })

  it('treats a pre-banner socket close as recoverable on the ladder only', () => {
    // ssh2 attaches no errno here, so the code table alone stranded hosts in 'error' after an outage.
    const err = Object.assign(new Error('Connection lost before handshake'), { level: 'protocol' })
    expect(isTransientError(err)).toBe(false)
    expect(isTransientReconnectError(err)).toBe(true)
  })

  it('keeps credential failures permanent', () => {
    expect(
      isTransientReconnectError(new Error('All configured authentication methods failed'))
    ).toBe(false)
    expect(
      isTransientReconnectError(
        new Error('System SSH probe failed (exit 255). stderr: Permission denied (publickey).')
      )
    ).toBe(false)
    expect(
      isTransientReconnectError(
        new Error('Encrypted private OpenSSH key detected, but no passphrase given')
      )
    ).toBe(false)
  })

  it.each([
    'ssh: connect to host box port 22: Connection refused',
    'ssh: connect to host box port 22: Connection reset by peer',
    'ssh: connect to host box port 22: Connection timed out',
    'ssh: connect to host box port 22: No route to host',
    'ssh: Could not resolve hostname box: Name or service not known'
  ])('recognizes definite host failures for the ControlMaster retry gate: %s', (message) => {
    expect(isDefiniteSystemSshHostFailure(new Error(message))).toBe(true)
  })

  it.each([
    'System SSH connection timed out',
    'Connection refused',
    'Connection reset by peer',
    'mux client failed: master is unresponsive'
  ])('keeps potentially mux-shaped failures eligible for direct retry: %s', (message) => {
    expect(isDefiniteSystemSshHostFailure(new Error(message))).toBe(false)
  })

  it('still covers the errno codes isTransientError already matched', () => {
    const err = new Error('refused') as NodeJS.ErrnoException
    err.code = 'ECONNREFUSED'
    expect(isTransientReconnectError(err)).toBe(true)
  })

  it('keeps unrelated failures permanent', () => {
    expect(isTransientReconnectError(new Error('something went wrong'))).toBe(false)
  })

  // Retrying re-derives the same verdict, so this would back off against an already-refused host
  // until the ladder gave up — with the reason buried under nine failed attempts.
  it('never retries a refused host key', () => {
    expect(isTransientReconnectError(new HostKeyVerificationError('key changed', 'mismatch'))).toBe(
      false
    )
  })

  // The classifier is otherwise substring-driven, so a reason that happened to contain network
  // wording would silently become retryable. The type is what decides.
  it('never retries a refused host key whose reason reads like a network fault', () => {
    const err = new HostKeyVerificationError('connection reset while checking the key', 'mismatch')
    expect(isTransientReconnectError(err)).toBe(false)
  })
})

// ── isTransientError ─────────────────────────────────────────────────

describe('isTransientError', () => {
  it('returns true for ETIMEDOUT code', () => {
    const err = new Error('timed out') as NodeJS.ErrnoException
    err.code = 'ETIMEDOUT'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ECONNREFUSED code', () => {
    const err = new Error('refused') as NodeJS.ErrnoException
    err.code = 'ECONNREFUSED'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ECONNRESET code', () => {
    const err = new Error('reset') as NodeJS.ErrnoException
    err.code = 'ECONNRESET'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for EHOSTUNREACH code', () => {
    const err = new Error('host unreachable') as NodeJS.ErrnoException
    err.code = 'EHOSTUNREACH'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ENETUNREACH code', () => {
    const err = new Error('net unreachable') as NodeJS.ErrnoException
    err.code = 'ENETUNREACH'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for EAI_AGAIN code', () => {
    const err = new Error('dns') as NodeJS.ErrnoException
    err.code = 'EAI_AGAIN'
    expect(isTransientError(err)).toBe(true)
  })

  it('returns true for ETIMEDOUT in message (no code)', () => {
    expect(isTransientError(new Error('connect ETIMEDOUT 1.2.3.4:22'))).toBe(true)
  })

  it('returns true for ECONNREFUSED in message', () => {
    expect(isTransientError(new Error('connect ECONNREFUSED 1.2.3.4:22'))).toBe(true)
  })

  it('returns true for ECONNRESET in message', () => {
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true)
  })

  it('returns true for the bounded SSH authentication watchdog', () => {
    const timeout = Object.assign(new Error('Timed out while waiting for SSH authentication'), {
      level: 'client-timeout'
    })

    expect(isTransientError(timeout)).toBe(true)
    expect(isTransientError(new Error('Timed out while waiting for SSH authentication'))).toBe(true)
  })

  it('returns false for auth errors', () => {
    expect(isTransientError(new Error('All configured authentication methods failed'))).toBe(false)
  })

  it('returns false for generic errors', () => {
    expect(isTransientError(new Error('something went wrong'))).toBe(false)
  })
})

// ── isSystemSshFallbackError ─────────────────────────────────────────

describe('isSystemSshFallbackError', () => {
  it('returns true for local reachability errors that system ssh may bypass', () => {
    const hostErr = new Error('host unreachable') as NodeJS.ErrnoException
    hostErr.code = 'EHOSTUNREACH'
    const netErr = new Error('net unreachable') as NodeJS.ErrnoException
    netErr.code = 'ENETUNREACH'

    expect(isSystemSshFallbackError(hostErr)).toBe(true)
    expect(isSystemSshFallbackError(netErr)).toBe(true)
  })

  it('returns false for transient errors that should keep the normal retry path', () => {
    const refused = new Error('refused') as NodeJS.ErrnoException
    refused.code = 'ECONNREFUSED'

    expect(isSystemSshFallbackError(refused)).toBe(false)
    expect(isSystemSshFallbackError(new Error('connect ETIMEDOUT 1.2.3.4:22'))).toBe(false)
  })
})

// ── isGssapiSystemSshFallbackCandidate ───────────────────────────────

describe('isGssapiSystemSshFallbackCandidate', () => {
  const authErr = new Error('All configured authentication methods failed')

  it('returns true for auth failures when resolved config enables GSSAPI', () => {
    expect(isGssapiSystemSshFallbackCandidate(authErr, {}, { gssapiAuthentication: true })).toBe(
      true
    )
  })

  it('returns true for passphrase failures so Kerberos SSO runs before prompting', () => {
    const passphraseErr = new Error('Encrypted private OpenSSH key detected, but no passphrase')
    expect(
      isGssapiSystemSshFallbackCandidate(passphraseErr, {}, { gssapiAuthentication: true })
    ).toBe(true)
  })

  it('returns false when the target already tried system ssh proactively', () => {
    expect(
      isGssapiSystemSshFallbackCandidate(
        authErr,
        { gssapiAuthentication: true },
        { gssapiAuthentication: true }
      )
    ).toBe(false)
  })

  it('returns false without GSSAPI in the resolved config', () => {
    expect(isGssapiSystemSshFallbackCandidate(authErr, {}, { gssapiAuthentication: false })).toBe(
      false
    )
    expect(isGssapiSystemSshFallbackCandidate(authErr, {}, null)).toBe(false)
  })

  it('returns false for network errors so retry semantics stay unchanged', () => {
    const netErr = new Error('connect ETIMEDOUT 1.2.3.4:22')
    expect(isGssapiSystemSshFallbackCandidate(netErr, {}, { gssapiAuthentication: true })).toBe(
      false
    )
  })
})

// ── isAuthError ──────────────────────────────────────────────────────

describe('isAuthError', () => {
  it('returns true for "All configured authentication methods failed"', () => {
    expect(isAuthError(new Error('All configured authentication methods failed'))).toBe(true)
  })

  it('returns true for "Authentication failed"', () => {
    expect(isAuthError(new Error('Authentication failed'))).toBe(true)
  })

  it('returns true for client-authentication level', () => {
    const err = new Error('auth') as Error & { level: string }
    err.level = 'client-authentication'
    expect(isAuthError(err)).toBe(true)
  })

  it('returns true for server auth-attempt exhaustion', () => {
    expect(isAuthError(new Error('Received disconnect: Too many authentication failures'))).toBe(
      true
    )
  })

  it.each([
    'Permission denied (publickey).',
    'Permission denied (publickey,password).',
    'Permission denied, please try again.'
  ])('detects OpenSSH credential rejection: %s', (message) => {
    expect(isAuthError(new Error(message))).toBe(true)
  })

  it('returns false for transient errors', () => {
    expect(isAuthError(new Error('connect ETIMEDOUT'))).toBe(false)
  })

  it('does not classify a local filesystem permission failure as authentication', () => {
    expect(isAuthError(new Error('Permission denied (os error 13)'))).toBe(false)
  })
})

// ── isAgentFallbackError ────────────────────────────────────────────

describe('isAgentFallbackError', () => {
  it('returns true for ssh2 agent-level failures', () => {
    const err = new Error('Failed to connect to agent') as Error & { level: string }
    err.level = 'agent'
    expect(isAgentFallbackError(err)).toBe(true)
  })

  it('returns true when agent auth exhausts the server auth attempt limit', () => {
    expect(
      isAgentFallbackError(new Error('Received disconnect: Too many authentication failures'))
    ).toBe(true)
  })

  it('keeps unrelated transport errors out of agent fallback handling', () => {
    expect(isAgentFallbackError(new Error('connect ECONNRESET'))).toBe(false)
  })
})
