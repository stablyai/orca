import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PRESS_AND_HOLD_KEY,
  ensureMacPressAndHoldDefault,
  readDomainPressAndHoldPreference,
  writeDomainPressAndHoldPreference,
  type PressAndHoldHost
} from './macos-press-and-hold-default'

// Verify real defaults distinguishes absence from false using disposable Orca-prefixed domains.

const domains: string[] = []

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

function hostFor(domain: string): PressAndHoldHost {
  return {
    platform: 'darwin',
    resolveBundleIdentifier: () => domain,
    readRecord: () => null,
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
        } catch {}
        // defaults delete empties the domain but leaves its plist behind.
        rmSync(join(homedir(), 'Library', 'Preferences', `${domain}.plist`), { force: true })
      }
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
  }
)
