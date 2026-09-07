import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '../shared/child-process/run-process'
import {
  PRESS_AND_HOLD_KEY,
  ensureMacPressAndHoldDefault,
  interpretDefaultsRead,
  readDomainPressAndHoldPreference,
  writeDomainPressAndHoldPreference,
  type PressAndHoldHost,
  type PressAndHoldRecord
} from './macos-press-and-hold-default'

/**
 * Runs against the real `/usr/bin/defaults` on a throwaway Orca-owned domain.
 *
 * The whole design rests on one claim the mocks cannot make: a domain that has never been written
 * is distinguishable from one explicitly set to `false`. Electron's `systemPreferences` cannot tell
 * them apart, so if `defaults` could not either, "only write when unset" would be unimplementable.
 *
 * Every domain used here is a throwaway UUID under Orca's own prefix, deleted along with its plist
 * in `afterEach`; the real `com.stablyai.orca` domain is never read or written.
 */

// Why a real Orca-owned domain shape: the ownership guard rejects anything else, so a fake prefix
// would exercise a different branch than production.
const domains: string[] = []

/** Pinned against the real binary below, then reused by the platform-agnostic unit tests. */
const DEFAULTS_MISSING_EXIT_CODE = 1

function throwawayDomain(): string {
  const domain = `com.stablyai.orca.defaults-domain-test.${randomUUID()}`
  domains.push(domain)
  return domain
}

function write(domain: string, value: 'true' | 'false'): void {
  execFileSync('/usr/bin/defaults', ['write', domain, PRESS_AND_HOLD_KEY, '-bool', value], {
    stdio: 'ignore'
  })
}

function rawRead(domain: string): string {
  return execFileSync('/usr/bin/defaults', ['read', domain, PRESS_AND_HOLD_KEY], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

function hostFor(domain: string, record: PressAndHoldRecord | null = null): PressAndHoldHost {
  return {
    platform: 'darwin',
    resolveBundleIdentifier: () => domain,
    readRecord: () => record,
    writeRecord: () => undefined,
    readDomainPreference: readDomainPressAndHoldPreference,
    writeDomainPreference: writeDomainPressAndHoldPreference,
    now: () => new Date().toISOString()
  }
}

describe.skipIf(process.platform !== 'darwin')(
  'press-and-hold against the real defaults binary',
  () => {
    afterEach(() => {
      for (const domain of domains.splice(0)) {
        try {
          execFileSync('/usr/bin/defaults', ['delete', domain], { stdio: 'ignore' })
        } catch {
          // The domain may never have been created; nothing to clean up.
        }
        // Why the file too: `defaults delete` empties the domain but leaves its plist behind, so
        // without this every run litters the developer's ~/Library/Preferences.
        rmSync(join(homedir(), 'Library', 'Preferences', `${domain}.plist`), { force: true })
      }
    })

    it('tells an unset key apart from an explicit false', () => {
      const unset = throwawayDomain()
      const explicitlyFalse = throwawayDomain()
      write(explicitlyFalse, 'false')

      expect(readDomainPressAndHoldPreference(unset)).toBe('unset')
      expect(readDomainPressAndHoldPreference(explicitlyFalse)).toBe('set')
      expect(rawRead(explicitlyFalse)).toBe('0')
    })

    it('reports an explicit true as set', () => {
      const domain = throwawayDomain()
      write(domain, 'true')

      expect(readDomainPressAndHoldPreference(domain)).toBe('set')
      expect(rawRead(domain)).toBe('1')
    })

    it('writes false into a previously unset domain', () => {
      const domain = throwawayDomain()

      expect(ensureMacPressAndHoldDefault(hostFor(domain))).toBe('applied')
      expect(rawRead(domain)).toBe('0')
    })

    it('leaves an explicit value untouched, in either direction', () => {
      for (const value of ['true', 'false'] as const) {
        const domain = throwawayDomain()
        write(domain, value)

        expect(ensureMacPressAndHoldDefault(hostFor(domain))).toBe('kept-user-preference')
        expect(rawRead(domain)).toBe(value === 'true' ? '1' : '0')
      }
    })

    it('refuses to call a failed probe "unset"', () => {
      // Real runs, not hand-built results: a binary that is not there must come back 'unknown'
      // through the same path production takes, not be mistaken for "the key does not exist".
      const spawnFailure = (): ReturnType<typeof runProcessSync> =>
        runProcessSync({
          program: '/usr/bin/defaults-does-not-exist',
          args: ['read'],
          stdio: ['ignore', 'ignore', 'ignore']
        })
      expect(spawnFailure).toThrow()
      expect(interpretDefaultsRead(spawnFailure)).toBe('unknown')

      const missingKey = runProcessSync({
        program: '/usr/bin/defaults',
        args: ['read', throwawayDomain(), PRESS_AND_HOLD_KEY],
        stdio: ['ignore', 'ignore', 'ignore']
      })
      // The one exit code the whole design reads as unset; every other outcome is 'unknown'.
      expect(missingKey.code).toBe(DEFAULTS_MISSING_EXIT_CODE)
      expect(missingKey.timedOut).toBe(false)
      expect(interpretDefaultsRead(() => missingKey)).toBe('unset')
    })

    // Skipped as root, where the read-only directory below would still be writable.
    it.skipIf(process.getuid?.() === 0)('reports a write the binary refused', () => {
      // Why a real refusal: `defaults write` exits non-zero instead of throwing, so a caller that
      // only caught exceptions would record 'applied' for a value that never reached the plist.
      const readOnly = join(mkdtempSync(join(tmpdir(), 'orca-press-hold-ro-')), 'locked')
      mkdirSync(readOnly)
      chmodSync(readOnly, 0o500)
      try {
        expect(writeDomainPressAndHoldPreference(join(readOnly, 'domain'), false)).toBe(false)
      } finally {
        chmodSync(readOnly, 0o700)
        rmSync(readOnly, { recursive: true, force: true })
      }
    })

    it('sees the key disappear again after the user deletes it', () => {
      const domain = throwawayDomain()
      write(domain, 'false')
      execFileSync('/usr/bin/defaults', ['delete', domain, PRESS_AND_HOLD_KEY], { stdio: 'ignore' })

      expect(readDomainPressAndHoldPreference(domain)).toBe('unset')
      // A launch that already decided must not rewrite it, which is what makes the delete stick.
      const decided: PressAndHoldRecord = {
        version: 1,
        decision: 'applied',
        domain,
        decidedAt: '2026-01-01T00:00:00.000Z'
      }
      expect(ensureMacPressAndHoldDefault(hostFor(domain, decided))).toBe('already-decided')
      expect(readDomainPressAndHoldPreference(domain)).toBe('unset')
    })
  }
)
