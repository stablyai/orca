import { describe, expect, it } from 'vitest'
import {
  decideHostKey,
  strictestHostKeyChecking,
  type HostKeyDecisionInput
} from './ssh-host-key-decision'

function input(overrides: Partial<HostKeyDecisionInput> = {}): HostKeyDecisionInput {
  return {
    knownHostsOutcome: 'unknown',
    storeOutcome: 'unknown',
    strictHostKeyChecking: 'ask',
    isEphemeralRuntimeTarget: false,
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

  // Precedence between the two sources, pinned in both directions. It was unpinned, and the order
  // was wrong: a legitimate key rotation is exactly the case where they disagree.
  it('accepts a rotated key once known_hosts holds it, even though our record is stale', () => {
    // What the remedy we print produces: `ssh-keygen -R host` then reconnect re-adds the NEW key to
    // known_hosts while our store still holds the old one. Refusing here was a permanent lockout,
    // because nothing in the app clears the store.
    expect(
      decideHostKey(input({ knownHostsOutcome: 'match', storeOutcome: 'mismatch' })).action
    ).toBe('accept')
  })

  it('still refuses a key known_hosts disagrees with, whatever our record says', () => {
    // The direction that must NOT be relaxed: known_hosts is authoritative for refusal too, so a
    // stale accept in our store cannot rescue a key ssh itself would reject.
    const decision = decideHostKey(input({ knownHostsOutcome: 'mismatch', storeOutcome: 'match' }))

    expect(decision.action).toBe('reject')
    expect(decision.disagreeingSource).toBe('known-hosts')
  })

  it('names the store file in a changed-key rejection so the user can act on it', () => {
    // Reachable for a host we trusted on first contact and never wrote to known_hosts: there is no
    // `ssh-keygen -R` that cures it, so "remove the saved key" has to name a file or it names
    // nothing. M1 fixed the case known_hosts CAN rescue; this is the one it cannot.
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
      // Same downgrade, our own records. Without this the guard covers known_hosts only, so a key
      // we learned on first contact could be sidestepped by presenting another type.
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

    // The reconnect ladder classifies on these substrings; a denial that reads as an auth error
    // gets retried forever against a decision that will never change.
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

    // Verified against OpenSSH 10.2p1: with both `[h]:2222` and `h` on file, `ssh-keygen -R h`
    // removes ONLY the bare line, and there is no port flag — `-R h -p 2222` is "Too many
    // arguments". So naming the bare host for an off-port target sends the user to run a command
    // that removes nothing and reconnect into the identical failure.
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

    // Verified live against OpenSSH 10.2p1: an ed25519 key offered where known_hosts holds only
    // ssh-rsa makes ssh print IDENTIFICATION HAS CHANGED and refuse. ssh is blocked too, so the
    // same remedy applies — without it this case diagnosed the problem and offered no way out.
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

    // INVERTED, by product decision. ssh2 cannot validate certificates at all, and OpenSSH itself
    // treats a CA-covered host presenting a plain key as first contact and connects. Refusing was
    // stricter than ssh, and because `@cert-authority *` is the normal Teleport/Vault-SSH/Smallstep
    // shape it failed EVERY target for those users — with an escape hatch that is an environment
    // variable, unreachable when Orca is launched from the Dock.
    it('does not refuse a certificate-authority host', () => {
      const decision = decideHostKey(input({ knownHostsOutcome: 'ca-only' }))
      expect(decision.action).toBe('accept-and-remember')
    })

    // The residual risk is accepted, not hidden: we take a plain key we cannot tie to the CA. The
    // outcome survives so the choice stays auditable in the decision log.
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
    // What `ssh -G` ACTUALLY prints for each configured value, captured from OpenSSH 10.2p1 (same
    // output from a config file and from -o). Driving the table from this rather than from the
    // configured spellings is the whole point: matching 'yes'/'no'/'off' matched nothing a real
    // config can produce, so config honouring was entirely dead and every unit test passed.
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

    // OpenSSH accepts here but does not write; persisting would turn a deliberately lax setting
    // into a permanent trust record.
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

    // The end-to-end statement: for every value a user can write, the decision we reach from what
    // ssh -G reports must equal the decision we would reach from the value they wrote.
    it.each(Object.entries(SSH_G_OUTPUT))(
      'reaches the same verdict for a configured %s as for the %s ssh -G prints',
      (configured, reported) => {
        expect(decideHostKey(input({ strictHostKeyChecking: reported })).action).toBe(
          decideHostKey(input({ strictHostKeyChecking: configured })).action
        )
      }
    )

    // Phase 1 has no dialog, so `ask` behaves as `accept-new` — deliberate, and the reason the
    // whole defence can ship without a modal. This pins the equivalence so Phase 2 has to break it
    // ON PURPOSE: `accept-new` must still not prompt, `ask` must.
    it('treats accept-new and ask alike while no dialog exists', () => {
      const acceptNew = decideHostKey(input({ strictHostKeyChecking: 'accept-new' }))
      const ask = decideHostKey(input({ strictHostKeyChecking: 'ask' }))
      expect(acceptNew.action).toBe('accept-and-remember')
      expect(ask.action).toBe(acceptNew.action)
    })

    // accept-new is a real OpenSSH value, not a typo — it must never fall into the strict branch.
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

  // By product decision: ssh warns and treats the host as unknown rather than refusing, and
  // refusing breaks an ordinary offline Windows laptop whose OneDrive-backed known_hosts is a cloud
  // placeholder — while blaming a config file that is fine. We connect as ssh does, but write
  // nothing, so a first contact we could not check never becomes durable trust.
  describe('an unreadable known_hosts file', () => {
    it('connects rather than refusing', () => {
      expect(decideHostKey(input({ knownHostsUnreadable: true })).action).toBe('accept')
    })

    it('does not record what it could not verify', () => {
      expect(decideHostKey(input({ knownHostsUnreadable: true })).action).not.toBe(
        'accept-and-remember'
      )
    })

    // The file we could not read cannot excuse a key that a source we COULD read says has changed.
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
    // A fresh VM presents a new key every launch, so recording one would accumulate a row per
    // launch and eventually turn a stale record into a spurious mismatch.
    it('accepts an ephemeral runtime target without remembering it', () => {
      expect(decideHostKey(input({ isEphemeralRuntimeTarget: true })).action).toBe('accept')
    })

    it('still rejects a changed key for an ephemeral target', () => {
      const decision = decideHostKey(
        input({ isEphemeralRuntimeTarget: true, knownHostsOutcome: 'mismatch' })
      )
      expect(decision.action).toBe('reject')
    })

    // We could not read the system ssh_config, so a site-wide policy may forbid this and we cannot
    // see it. Being laxer than a policy we cannot read is the one outcome that is never acceptable.
    it('denies an unknown host when a source could not be read', () => {
      expect(decideHostKey(input({ siteConfigSuppressed: true })).action).toBe('reject')
    })

    // Only NEW trust is withheld. A host we already know is decided before this is reached, so
    // being unable to read the site config does not disconnect everything the user already verified.
    it('still accepts a known host when a source could not be read', () => {
      const decision = decideHostKey(
        input({ siteConfigSuppressed: true, knownHostsOutcome: 'match' })
      )
      expect(decision.action).toBe('accept')
    })

    // A VM provisioned a minute ago cannot be in known_hosts, so no policy — seen or unseen — is
    // satisfiable by it. Refusing would not make the connection safer, it would turn on-demand
    // runtimes off for everyone whose HOME diverges from their passwd home.
    it('still accepts an ephemeral target when a source could not be read', () => {
      const decision = decideHostKey(
        input({ isEphemeralRuntimeTarget: true, siteConfigSuppressed: true })
      )
      expect(decision.action).toBe('accept')
    })

    // The exception to the exception: an explicit StrictHostKeyChecking=yes is a policy we can
    // actually read and the user actually asked for, so it outranks the carve-out.
    it('denies an ephemeral target under an explicit StrictHostKeyChecking=yes', () => {
      const decision = decideHostKey(
        input({ isEphemeralRuntimeTarget: true, strictHostKeyChecking: 'yes' })
      )
      expect(decision.action).toBe('reject')
    })

    // The carve-out is about first contact only; a key that CHANGED is still a change.
    it('still rejects a changed key for an ephemeral target with sources incomplete', () => {
      const decision = decideHostKey(
        input({
          isEphemeralRuntimeTarget: true,
          siteConfigSuppressed: true,
          storeOutcome: 'mismatch'
        })
      )
      expect(decision.action).toBe('reject')
    })
  })

  // Phase 1 ships no dialog at all: startup restore opens many connections at once, ephemeral
  // targets would prompt every launch, and paired-web connects run on someone else's desktop.
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
      { isEphemeralRuntimeTarget: true },
      { siteConfigSuppressed: true },
      { knownHostsUnreadable: true }
    ]
    for (const overrides of cases) {
      expect(decideHostKey(input(overrides)).action).not.toBe('prompt')
    }
  })
})

/**
 * Merging a user-resolved policy with a separately-probed site policy.
 *
 * Only reachable on the `-F` path, where OpenSSH ignores /etc/ssh/ssh_config so the per-user
 * resolution cannot represent a site policy at all. Before this, being unable to see the site policy
 * meant refusing every unknown host — which locked out anyone whose HOME diverges from their passwd
 * home (devcontainers, `su`, Nix shells) with no override.
 */
describe('merging the user and site host key policies', () => {
  it('keeps the user value when the site could not be read', () => {
    // The blind case that still fails strict: a null probe must not invent a policy.
    expect(strictestHostKeyChecking('ask', null)).toBe('ask')
    expect(strictestHostKeyChecking(undefined, null)).toBe('ask')
  })

  it('takes a strict site policy over a laxer user value', () => {
    expect(strictestHostKeyChecking('ask', 'yes')).toBe('yes')
    expect(strictestHostKeyChecking('no', 'true')).toBe('true')
  })

  it('does not let a lax site policy loosen the user', () => {
    // The direction that must never relax: a permissive site config cannot downgrade a user who
    // asked for strict, or we end up laxer than ssh itself.
    expect(strictestHostKeyChecking('yes', 'no')).toBe('yes')
    expect(strictestHostKeyChecking('ask', 'off')).toBe('ask')
  })

  it('lets the site raise ask to accept-new', () => {
    expect(strictestHostKeyChecking('ask', 'accept-new')).toBe('accept-new')
  })

  it('keeps a strict user value against accept-new', () => {
    expect(strictestHostKeyChecking('yes', 'accept-new')).toBe('yes')
  })
})
