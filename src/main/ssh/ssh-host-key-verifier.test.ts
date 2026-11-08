import { describe, expect, it, vi } from 'vitest'
import { parseKnownHosts } from './config/ssh-known-hosts'
import {
  createHostKeyVerifier,
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

  describe('denials that bypass the policy', () => {
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
  })
})

describe('host key algorithm ordering', () => {
  const supported = ['ssh-ed25519', 'rsa-sha2-512', 'ssh-rsa', 'ecdsa-sha2-nistp256']

  // One ssh-rsa key negotiates as rsa-sha2-512/256 or ssh-rsa; promote them together.
  it('promotes every RSA signature algorithm for a known ssh-rsa key', () => {
    const entries = parseKnownHosts(`example.com ssh-rsa ${RSA_A}`)
    const ordered = orderServerHostKeyAlgorithms(entries, 'example.com', 22, supported)
    expect(ordered?.slice(0, 2).sort()).toEqual(['rsa-sha2-512', 'ssh-rsa'])
    expect(ordered?.indexOf('ssh-ed25519')).toBeGreaterThan(1)
  })
})
