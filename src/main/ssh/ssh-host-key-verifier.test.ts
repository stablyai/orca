import { describe, expect, it, vi } from 'vitest'
import { parseKnownHosts } from './config/ssh-known-hosts'
import {
  createHostKeyVerifier,
  getDefaultServerHostKeyAlgorithms,
  hostKeyFingerprintOf,
  orderServerHostKeyAlgorithms,
  type HostKeyVerifierDeps
} from './ssh-host-key-verifier'

const ED_A = 'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
const ED_B = 'AAAAC3NzaC1lZDI1NTE5AAAAILu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7'
const RSA_A =
  'AAAAB3NzaC1yc2EAAABAzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzA=='

const blob = (base64: string): Buffer => Buffer.from(base64, 'base64')

function deps(overrides: Partial<HostKeyVerifierDeps> = {}): HostKeyVerifierDeps {
  return {
    host: 'example.com',
    port: 22,
    displayHost: 'example.com',
    strictHostKeyChecking: 'ask',
    policy: { kind: 'standard' },
    siteConfigSuppressed: false,
    knownHostsUnreadable: false,
    entries: [],
    isTrusted: () => 'unknown',
    rememberHostKey: vi.fn(),
    ...overrides
  }
}

function run(
  overrides: Partial<HostKeyVerifierDeps>,
  key = ED_A
): { accepted: boolean | undefined; returned: unknown } {
  let accepted: boolean | undefined
  const verifier = createHostKeyVerifier(deps(overrides))
  const returned = verifier(blob(key), (ok) => {
    accepted = ok
  })
  return { accepted, returned }
}

describe('the ssh2 host key verifier', () => {
  // ssh2 treats any non-undefined return, including an async Promise, as acceptance before callback verification.
  it('returns nothing, so ssh2 waits for the callback', () => {
    expect(run({}).returned).toBeUndefined()
  })

  it('accepts a key the user already has in known_hosts', () => {
    const entries = parseKnownHosts(`example.com ssh-ed25519 ${ED_A}`)
    expect(run({ entries }).accepted).toBe(true)
  })

  it('accepts a key our own store already holds', () => {
    expect(run({ isTrusted: () => 'match' }).accepted).toBe(true)
  })

  it('rejects a changed key', () => {
    const entries = parseKnownHosts(`example.com ssh-ed25519 ${ED_B}`)
    expect(run({ entries }).accepted).toBe(false)
  })

  it('rejects a revoked key', () => {
    const entries = parseKnownHosts(`@revoked example.com ssh-ed25519 ${ED_A}`)
    expect(run({ entries }).accepted).toBe(false)
  })

  it('rejects a key whose own header cannot be read', () => {
    let accepted: boolean | undefined
    createHostKeyVerifier(deps())(Buffer.alloc(2), (ok) => {
      accepted = ok
    })
    expect(accepted).toBe(false)
  })

  // ssh2 may not catch a throw from inside the verifier, which would hang the handshake instead of
  // failing it.
  it('denies rather than throwing when a dependency fails', () => {
    const { accepted, returned } = run({
      isTrusted: () => {
        throw new Error('store unreadable')
      }
    })
    expect(accepted).toBe(false)
    expect(returned).toBeUndefined()
  })

  // A superseded attempt has nobody waiting on it; accepting would record trust for a connection
  // that no longer exists.
  it('denies once its connect attempt has been superseded', () => {
    const { accepted } = run({ isCurrentAttempt: () => false })
    expect(accepted).toBe(false)
  })

  it('does not record a key for a superseded attempt', () => {
    const rememberHostKey = vi.fn()
    run({ isCurrentAttempt: () => false, rememberHostKey })
    expect(rememberHostKey).not.toHaveBeenCalled()
  })

  describe('remembering', () => {
    it('records a first-contact key', () => {
      const rememberHostKey = vi.fn()
      run({ rememberHostKey })
      expect(rememberHostKey).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'example.com',
          port: 22,
          keyType: 'ssh-ed25519',
          fingerprint: hostKeyFingerprintOf(blob(ED_A))
        })
      )
    })

    it.each([
      ['a key we already know', { entries: parseKnownHosts(`example.com ssh-ed25519 ${ED_A}`) }],
      ['a rejected key', { entries: parseKnownHosts(`example.com ssh-ed25519 ${ED_B}`) }],
      ['an ephemeral runtime target', { policy: { kind: 'ephemeral' as const } }],
      ['a lax StrictHostKeyChecking', { strictHostKeyChecking: 'no' }]
    ])('does not record %s', (_label, overrides) => {
      const rememberHostKey = vi.fn()
      run({ ...overrides, rememberHostKey })
      expect(rememberHostKey).not.toHaveBeenCalled()
    })
  })

  it('reports every decision for audit', () => {
    const onDecision = vi.fn()
    run({ onDecision })
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'unknown', keyType: 'ssh-ed25519' })
    )
  })

  describe('denials that bypass the policy', () => {
    // Report every denial so credential fallback cannot prompt against a host already refused.
    it('reports a denial for a key it could not read', () => {
      const onDecision = vi.fn()
      createHostKeyVerifier(deps({ onDecision }))(Buffer.alloc(2), () => {})
      expect(onDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'reject',
          reason: expect.stringContaining('example.com')
        })
      )
    })

    it('reports a denial when a dependency throws', () => {
      const onDecision = vi.fn()
      run({
        onDecision,
        isTrusted: () => {
          throw new Error('store unreadable')
        }
      })
      expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ action: 'reject' }))
    })

    // No parseable key means no fingerprint; bogus values must not replace the install-lock identity.
    it('reports no fingerprint for a key it could not read', () => {
      const onDecision = vi.fn()
      createHostKeyVerifier(deps({ onDecision }))(Buffer.alloc(2), () => {})
      expect(onDecision.mock.calls[0]?.[0]?.fingerprint).toBe('')
    })

    // Reporting failure inside verifier catch must still deny, never escape and hang handshake.
    it('still denies when reporting the denial throws', () => {
      let accepted: boolean | undefined
      const verifier = createHostKeyVerifier(
        deps({
          onDecision: () => {
            throw new Error('listener blew up')
          }
        })
      )
      expect(() =>
        verifier(Buffer.alloc(2), (ok) => {
          accepted = ok
        })
      ).not.toThrow()
      expect(accepted).toBe(false)
    })

    // Superseded verifiers must not overwrite the live attempt's reported outcome.
    it('reports nothing once its attempt has been superseded', () => {
      const onDecision = vi.fn()
      run({ onDecision, isCurrentAttempt: () => false })
      expect(onDecision).not.toHaveBeenCalled()
    })
  })
})

describe('the ssh2 default algorithm list', () => {
  const ssh2Constants = require('ssh2/lib/protocol/constants.js') as {
    DEFAULT_SERVER_HOST_KEY: string[]
    SUPPORTED_SERVER_HOST_KEY: string[]
  }

  it('is read from ssh2, not guessed', () => {
    expect(getDefaultServerHostKeyAlgorithms()).toEqual(ssh2Constants.DEFAULT_SERVER_HOST_KEY)
  })

  it('proposes nothing ssh2 would refuse', () => {
    for (const algorithm of getDefaultServerHostKeyAlgorithms() ?? []) {
      expect(ssh2Constants.SUPPORTED_SERVER_HOST_KEY).toContain(algorithm)
    }
  })

  // Keep all RSA signature names so one known ssh-rsa key can be promoted under every negotiated algorithm.
  it('contains the RSA signature algorithms the ordering maps onto', () => {
    expect(getDefaultServerHostKeyAlgorithms() ?? []).toEqual(
      expect.arrayContaining(['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512'])
    )
  })
})

describe('host key algorithm ordering', () => {
  const supported = ['ssh-ed25519', 'rsa-sha2-512', 'ssh-rsa', 'ecdsa-sha2-nistp256']

  // Lead with stored types so another algorithm cannot turn mismatch into first contact.
  it('leads with the types already known for the host', () => {
    const entries = parseKnownHosts(`example.com ssh-rsa ${RSA_A}`)
    const ordered = orderServerHostKeyAlgorithms(entries, 'example.com', 22, supported)
    expect(ordered?.[0]).toMatch(/rsa/)
    expect(ordered?.indexOf('ssh-ed25519')).toBeGreaterThan(0)
  })

  it('keeps every supported algorithm, only reordered', () => {
    const entries = parseKnownHosts(`example.com ssh-rsa ${RSA_A}`)
    const ordered = orderServerHostKeyAlgorithms(entries, 'example.com', 22, supported)
    expect([...(ordered ?? [])].sort()).toEqual([...supported].sort())
  })

  it('leaves the defaults alone for a host we know nothing about', () => {
    const entries = parseKnownHosts(`other.com ssh-rsa ${RSA_A}`)
    expect(orderServerHostKeyAlgorithms(entries, 'example.com', 22, supported)).toBeUndefined()
  })

  it('ignores a revoked entry when choosing what to lead with', () => {
    const entries = parseKnownHosts(`@revoked example.com ssh-rsa ${RSA_A}`)
    expect(orderServerHostKeyAlgorithms(entries, 'example.com', 22, supported)).toBeUndefined()
  })

  // One ssh-rsa key negotiates as rsa-sha2-512/256 or ssh-rsa; promote them together.
  it('promotes every RSA signature algorithm for a known ssh-rsa key', () => {
    const entries = parseKnownHosts(`example.com ssh-rsa ${RSA_A}`)
    const ordered = orderServerHostKeyAlgorithms(entries, 'example.com', 22, supported)
    expect(ordered?.slice(0, 2).sort()).toEqual(['rsa-sha2-512', 'ssh-rsa'])
    expect(ordered?.indexOf('ssh-ed25519')).toBeGreaterThan(1)
  })

  // Store-only known types need the same proposal protection as known_hosts types.
  it('leads with a type known only from our own store', () => {
    const ordered = orderServerHostKeyAlgorithms([], 'example.com', 22, supported, ['ssh-rsa'])
    expect(ordered?.[0]).toMatch(/rsa/)
    expect(ordered?.indexOf('ssh-ed25519')).toBeGreaterThan(0)
  })

  it('does not propose a type the transport does not support', () => {
    const entries = parseKnownHosts(`example.com ssh-ed25519 ${ED_A}`)
    const ordered = orderServerHostKeyAlgorithms(entries, 'example.com', 22, ['rsa-sha2-512'])
    expect(ordered).toBeUndefined()
  })
})
