import { describe, expect, it } from 'vitest'
import {
  decideHostKey,
  hostKeyPolicyForOwner,
  type HostKeyDecisionInput
} from './ssh-host-key-decision'

function input(overrides: Partial<HostKeyDecisionInput> = {}): HostKeyDecisionInput {
  return {
    knownHostsOutcome: 'unknown',
    storeOutcome: 'unknown',
    strictHostKeyChecking: 'ask',
    policy: { kind: 'standard' },
    siteConfigSuppressed: false,
    knownHostsUnreadable: false,
    displayHost: 'build-01',
    port: 22,
    ...overrides
  }
}

describe('deciding what to do with a presented host key', () => {
  it('accepts a key either source already holds', () => {
    expect(decideHostKey(input({ knownHostsOutcome: 'match' })).action).toBe('accept')
    expect(decideHostKey(input({ storeOutcome: 'match' })).action).toBe('accept')
  })

  // Pin known_hosts precedence in both directions so legitimate rotation can recover from stale Orca trust.
  it('accepts a rotated key once known_hosts holds it, even though our record is stale', () => {
    expect(
      decideHostKey(input({ knownHostsOutcome: 'match', storeOutcome: 'mismatch' })).action
    ).toBe('accept')
  })

  it('still refuses a key known_hosts disagrees with, whatever our record says', () => {
    // A stale Orca accept cannot override known_hosts refusal.
    const decision = decideHostKey(input({ knownHostsOutcome: 'mismatch', storeOutcome: 'match' }))

    expect(decision.action).toBe('reject')
    expect(decision.disagreeingSource).toBe('known-hosts')
  })

  it('names the store file in a changed-key rejection so the user can act on it', () => {
    // Store-only trust has no ssh-keygen remedy; changed-key guidance must name the actual store file.
    const decision = decideHostKey(
      input({ storeOutcome: 'mismatch', hostKeyStoreFile: '/data/orca/ssh-host-keys.json' })
    )

    expect(decision.action).toBe('reject')
    expect(decision.reason).toContain('/data/orca/ssh-host-keys.json')
  })

  it('falls back to the generic hint when the store path is unknown', () => {
    const decision = decideHostKey(input({ storeOutcome: 'mismatch' }))

    expect(decision.action).toBe('reject')
    expect(decision.reason).toContain('remove the saved key')
  })

  it('remembers a first-contact key', () => {
    expect(decideHostKey(input()).action).toBe('accept-and-remember')
  })

  describe('rejections', () => {
    it.each([
      ['a revoked key', { knownHostsOutcome: 'revoked' as const }, 'revoked'],
      ['a changed key in known_hosts', { knownHostsOutcome: 'mismatch' as const }, 'mismatch'],
      ['a changed key in our own record', { storeOutcome: 'mismatch' as const }, 'mismatch'],
      [
        'an unfamiliar key type for a host we know',
        { knownHostsOutcome: 'unknown-type-known-host' as const },
        'unknown-type-known-host'
      ],
      // Store-only known hosts must reject type-switch downgrade attempts too.
      [
        'an unfamiliar key type for a host only we know',
        { storeOutcome: 'unknown-type-known-host' as const },
        'unknown-type-known-host'
      ]
    ])('rejects %s', (_label, overrides, outcome) => {
      const decision = decideHostKey(input(overrides))
      expect(decision.action).toBe('reject')
      expect(decision.outcome).toBe(outcome)
      expect(decision.reason).toBeTruthy()
    })

    // Revocation is a statement that this key is known-bad, so it outranks a lax setting.
    it('rejects a revoked key even when checking is disabled', () => {
      const decision = decideHostKey(
        input({ knownHostsOutcome: 'revoked', strictHostKeyChecking: 'no' })
      )
      expect(decision.action).toBe('reject')
    })

    it('rejects a changed key even when checking is disabled', () => {
      const decision = decideHostKey(
        input({ knownHostsOutcome: 'mismatch', strictHostKeyChecking: 'off' })
      )
      expect(decision.action).toBe('reject')
    })

    // Auth-like denial wording would send permanent host-key refusal through credential retry.
    it.each([
      ['a revoked key', { knownHostsOutcome: 'revoked' as const }],
      ['a changed key', { knownHostsOutcome: 'mismatch' as const }],
      ['an unknown host under strict checking', { strictHostKeyChecking: 'yes' }]
    ])('does not phrase %s as an authentication error', (_label, overrides) => {
      const reason = decideHostKey(input(overrides)).reason ?? ''
      expect(reason.toLowerCase()).not.toContain('authentication failed')
      expect(reason.toLowerCase()).not.toContain('permission denied')
    })

    it('names the remedy that also unblocks ssh when known_hosts disagrees', () => {
      const decision = decideHostKey(input({ knownHostsOutcome: 'mismatch' }))
      expect(decision.disagreeingSource).toBe('known-hosts')
      expect(decision.reason).toContain('ssh-keygen -R build-01')
    })

    // OpenSSH 10.2p1 removes only the bracketed [host]:port entry off port 22; -R has no port flag.
    it('names the bracketed entry when the port is not the default', () => {
      const decision = decideHostKey(input({ knownHostsOutcome: 'mismatch', port: 2222 }))
      expect(decision.reason).toContain("ssh-keygen -R '[build-01]:2222'")
    })

    it('does not bracket the host on the default port', () => {
      const decision = decideHostKey(input({ knownHostsOutcome: 'mismatch', port: 22 }))
      expect(decision.reason).toContain('ssh-keygen -R build-01')
      expect(decision.reason).not.toContain('[build-01]')
    })

    it('names the bracketed entry for an unfamiliar key type on a non-default port too', () => {
      const decision = decideHostKey(
        input({ knownHostsOutcome: 'unknown-type-known-host', port: 2222 })
      )
      expect(decision.reason).toContain("ssh-keygen -R '[build-01]:2222'")
    })

    it('does not tell the user to edit known_hosts when our own record disagrees', () => {
      const decision = decideHostKey(input({ storeOutcome: 'mismatch' }))
      expect(decision.disagreeingSource).toBe('orca-store')
      expect(decision.reason).not.toContain('ssh-keygen -R')
    })

    // A different key type triggers OpenSSH changed-host refusal too; provide its ssh-keygen remedy.
    it('names the remedy for an unfamiliar key type known_hosts disagrees on', () => {
      const decision = decideHostKey(input({ knownHostsOutcome: 'unknown-type-known-host' }))
      expect(decision.disagreeingSource).toBe('known-hosts')
      expect(decision.reason).toContain('ssh-keygen -R build-01')
    })

    // Our own record is not in known_hosts, so ssh-keygen -R would remove nothing.
    it('does not name ssh-keygen for an unfamiliar key type only we know about', () => {
      const decision = decideHostKey(input({ storeOutcome: 'unknown-type-known-host' }))
      expect(decision.disagreeingSource).toBe('orca-store')
      expect(decision.reason).not.toContain('ssh-keygen -R')
      expect(decision.reason).toContain('rebuilt')
    })

    // Product policy follows OpenSSH first contact for CA-only plain keys; ssh2 cannot validate certificates.
    it('does not refuse a certificate-authority host', () => {
      const decision = decideHostKey(input({ knownHostsOutcome: 'ca-only' }))
      expect(decision.action).toBe('accept-and-remember')
    })

    // Retain CA-only outcome for audit: accepted plain keys cannot be tied to the CA.
    it('still reports the certificate-authority outcome for audit', () => {
      expect(decideHostKey(input({ knownHostsOutcome: 'ca-only' })).outcome).toBe('ca-only')
    })

    // A CA line does not license a CHANGED key: a plain entry for the host still decides.
    it('still refuses a changed key on a certificate-authority host', () => {
      const decision = decideHostKey(
        input({ knownHostsOutcome: 'ca-only', storeOutcome: 'mismatch' })
      )
      expect(decision.action).toBe('reject')
    })
  })

  describe('StrictHostKeyChecking', () => {
    // Use real OpenSSH 10.2p1 ssh -G output: yes→true, no/off→false, ask/accept-new unchanged. Config spellings alone missed actual policy.
    const SSH_G_OUTPUT: Record<string, string> = {
      yes: 'true',
      no: 'false',
      off: 'false',
      'accept-new': 'accept-new',
      ask: 'ask'
    }

    it.each([['yes'], ['always']])('denies an unknown host under %s', (value) => {
      expect(decideHostKey(input({ strictHostKeyChecking: value })).action).toBe('reject')
    })

    it('denies an unknown host for a config that says yes, as ssh -G reports it', () => {
      const asReported = SSH_G_OUTPUT.yes
      expect(asReported).toBe('true')
      expect(decideHostKey(input({ strictHostKeyChecking: asReported })).action).toBe('reject')
    })

    // Lax OpenSSH policy accepts without persisting; never convert it into durable trust.
    it.each([['no'], ['off']])('accepts without remembering under %s', (value) => {
      expect(decideHostKey(input({ strictHostKeyChecking: value })).action).toBe('accept')
    })

    it.each([['no'], ['off']])(
      'accepts without remembering for a config that says %s, as ssh -G reports it',
      (value) => {
        const asReported = SSH_G_OUTPUT[value]
        expect(asReported).toBe('false')
        expect(decideHostKey(input({ strictHostKeyChecking: asReported })).action).toBe('accept')
      }
    )

    // Configured and ssh -G-normalized spellings must produce identical decisions.
    it.each(Object.entries(SSH_G_OUTPUT))(
      'reaches the same verdict for a configured %s as for the %s ssh -G prints',
      (configured, reported) => {
        expect(decideHostKey(input({ strictHostKeyChecking: reported })).action).toBe(
          decideHostKey(input({ strictHostKeyChecking: configured })).action
        )
      }
    )

    // Until prompt UI exists, ask deliberately equals accept-new; future prompting must split them explicitly.
    it('treats accept-new and ask alike while no dialog exists', () => {
      const acceptNew = decideHostKey(input({ strictHostKeyChecking: 'accept-new' }))
      const ask = decideHostKey(input({ strictHostKeyChecking: 'ask' }))
      expect(acceptNew.action).toBe('accept-and-remember')
      expect(ask.action).toBe(acceptNew.action)
    })

    it('does not treat accept-new as strict', () => {
      expect(decideHostKey(input({ strictHostKeyChecking: 'accept-new' })).action).not.toBe(
        'reject'
      )
    })

    it('treats an unrecognised value as ask', () => {
      expect(decideHostKey(input({ strictHostKeyChecking: 'banana' })).action).toBe(
        'accept-and-remember'
      )
    })

    it('is case-insensitive', () => {
      expect(decideHostKey(input({ strictHostKeyChecking: 'YES' })).action).toBe('reject')
    })
  })

  // Unreadable known_hosts, including offline OneDrive placeholders, permits connection like ssh but must never record unverified trust.
  describe('an unreadable known_hosts file', () => {
    it('connects rather than refusing', () => {
      expect(decideHostKey(input({ knownHostsUnreadable: true })).action).toBe('accept')
    })

    it('does not record what it could not verify', () => {
      expect(decideHostKey(input({ knownHostsUnreadable: true })).action).not.toBe(
        'accept-and-remember'
      )
    })

    // Unreadable files cannot excuse a mismatch from a readable source.
    it('still refuses a changed key', () => {
      const decision = decideHostKey(
        input({ knownHostsUnreadable: true, knownHostsOutcome: 'mismatch' })
      )
      expect(decision.action).toBe('reject')
    })

    it('still refuses a revoked key', () => {
      const decision = decideHostKey(
        input({ knownHostsUnreadable: true, knownHostsOutcome: 'revoked' })
      )
      expect(decision.action).toBe('reject')
    })

    // An unreadable file is weaker evidence than a policy we know exists but cannot read.
    it('does not override an explicit StrictHostKeyChecking', () => {
      const decision = decideHostKey(
        input({ knownHostsUnreadable: true, strictHostKeyChecking: 'true' })
      )
      expect(decision.action).toBe('reject')
    })
  })

  describe('carve-outs', () => {
    // Ephemeral keys rotate each launch; recording them accumulates stale trust and false mismatches.
    it('accepts an ephemeral runtime target without remembering it', () => {
      expect(decideHostKey(input({ policy: { kind: 'ephemeral' } })).action).toBe('accept')
    })

    it('still rejects a changed key for an ephemeral target', () => {
      const decision = decideHostKey(
        input({ policy: { kind: 'ephemeral' }, knownHostsOutcome: 'mismatch' })
      )
      expect(decision.action).toBe('reject')
    })

    // Unseen site policy cannot authorize new durable-host trust.
    it('denies an unknown host when a source could not be read', () => {
      expect(decideHostKey(input({ siteConfigSuppressed: true })).action).toBe('reject')
    })

    // Incomplete site-policy evidence withholds only new trust; known verified hosts still connect.
    it('still accepts a known host when a source could not be read', () => {
      const decision = decideHostKey(
        input({ siteConfigSuppressed: true, knownHostsOutcome: 'match' })
      )
      expect(decision.action).toBe('accept')
    })

    // Ephemeral VMs cannot satisfy unseen prior-trust policy; permit first contact without recording.
    it('still accepts an ephemeral target when a source could not be read', () => {
      const decision = decideHostKey(
        input({ policy: { kind: 'ephemeral' }, siteConfigSuppressed: true })
      )
      expect(decision.action).toBe('accept')
    })

    // Explicit readable strict policy overrides the ephemeral first-contact exception.
    it('denies an ephemeral target under an explicit StrictHostKeyChecking=yes', () => {
      const decision = decideHostKey(
        input({ policy: { kind: 'ephemeral' }, strictHostKeyChecking: 'yes' })
      )
      expect(decision.action).toBe('reject')
    })

    it('still rejects a changed key for an ephemeral target with sources incomplete', () => {
      const decision = decideHostKey(
        input({
          policy: { kind: 'ephemeral' },
          siteConfigSuppressed: true,
          storeOutcome: 'mismatch'
        })
      )
      expect(decision.action).toBe('reject')
    })
  })

  // Promptless policy also supports concurrent restore and paired clients on other desktops.
  it('never asks for a prompt', () => {
    const cases: Partial<HostKeyDecisionInput>[] = [
      {},
      { knownHostsOutcome: 'match' },
      { knownHostsOutcome: 'mismatch' },
      { knownHostsOutcome: 'revoked' },
      { knownHostsOutcome: 'ca-only' },
      { knownHostsOutcome: 'unknown-type-known-host' },
      { storeOutcome: 'match' },
      { storeOutcome: 'mismatch' },
      { strictHostKeyChecking: 'yes' },
      { strictHostKeyChecking: 'no' },
      { policy: { kind: 'ephemeral' } },
      { siteConfigSuppressed: true },
      { knownHostsUnreadable: true }
    ]
    for (const overrides of cases) {
      expect(decideHostKey(input(overrides)).action).not.toBe('prompt')
    }
  })
})

describe('hostKeyPolicyForOwner', () => {
  it('trusts first contact only for ephemeral runtime VMs', () => {
    expect(hostKeyPolicyForOwner({ type: 'on-demand-runtime', runtimeId: 'vm-1' })).toEqual({
      kind: 'ephemeral'
    })
    expect(
      hostKeyPolicyForOwner({ type: 'on-demand-runtime', runtimeId: 'managed-orcad:env-1' })
    ).toEqual({ kind: 'standard' })
    expect(hostKeyPolicyForOwner(undefined)).toEqual({ kind: 'standard' })
  })
})
