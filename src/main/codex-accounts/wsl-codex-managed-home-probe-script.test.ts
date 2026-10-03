import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../wsl', () => ({
  toWindowsWslPath: (linuxPath: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}))

import {
  buildWslCodexManagedHomeProbeScript,
  classifyWslCodexManagedHomeProbe
} from './wsl-codex-managed-home-probe'

/**
 * Runs the real guest script under a POSIX shell against real fixtures, because
 * the defects this covers are shell semantics — `test -e` and `test -f` report
 * the same status for "absent" and "cannot look" — which no string assertion on
 * the generated script can catch.
 */
const DISTRO = 'Ubuntu'
const ACCOUNT_ID = 'account-1'

describe.skipIf(process.platform === 'win32')('WSL probe script against a real filesystem', () => {
  let guestHome: string
  let managedRoot: string
  let accountDir: string
  let candidate: string
  let marker: string
  const restoreModes: string[] = []

  beforeEach(() => {
    guestHome = mkdtempSync(join(tmpdir(), 'orca-wsl-probe-'))
    managedRoot = join(guestHome, '.local', 'share', 'orca', 'codex-accounts')
    accountDir = join(managedRoot, ACCOUNT_ID)
    candidate = join(accountDir, 'home')
    marker = join(candidate, '.orca-managed-home')
    mkdirSync(candidate, { recursive: true })
    writeFileSync(marker, `${ACCOUNT_ID}\n`, 'utf-8')
    restoreModes.length = 0
  })

  afterEach(() => {
    for (const path of restoreModes) {
      try {
        chmodSync(path, 0o755)
      } catch {
        // already gone
      }
    }
    rmSync(guestHome, { recursive: true, force: true })
  })

  function seal(path: string): void {
    restoreModes.push(path)
    chmodSync(path, 0o000)
  }

  function probe(expectedAccountId: string | undefined = ACCOUNT_ID) {
    const script = buildWslCodexManagedHomeProbeScript(candidate, expectedAccountId)
    let stdout: string
    try {
      stdout = execFileSync('bash', ['-c', script], {
        encoding: 'utf-8',
        env: { ...process.env, HOME: guestHome },
        timeout: 20_000
      })
    } catch (error) {
      return classifyWslCodexManagedHomeProbe({ ran: false, error }, DISTRO)
    }
    return classifyWslCodexManagedHomeProbe({ ran: true, stdout }, DISTRO)
  }

  it('accepts a real, correctly marked managed home', () => {
    // The guest canonicalises, and macOS resolves the temp root through /private.
    const canonical = realpathSync(candidate)

    expect(probe()).toEqual({
      kind: 'owned',
      homePath: `\\\\wsl.localhost\\${DISTRO}${canonical.replace(/\//g, '\\')}`
    })
  })

  it('reports a home whose parent directory cannot be searched as indeterminate', () => {
    // The home is present; only permission is missing. `test -e` cannot tell that
    // from absence, and an absence tag is a trust verdict.
    seal(accountDir)

    expect(probe().kind).toBe('indeterminate')
  })

  it('reports a marker that cannot be reached as indeterminate', () => {
    seal(candidate)

    expect(probe().kind).toBe('indeterminate')
  })

  it('reports a symlink loop in the home position as indeterminate', () => {
    // `test -e` fails with ELOOP while the entry is still listed in its parent,
    // so "not stattable" and "not there" are genuinely different observations.
    rmSync(candidate, { recursive: true })
    symlinkSync(join(accountDir, 'loop-b'), candidate)
    symlinkSync(candidate, join(accountDir, 'loop-b'))

    expect(probe().kind).toBe('indeterminate')
  })

  it('still reports a genuinely absent home as untrusted', () => {
    rmSync(candidate, { recursive: true })

    expect(probe()).toEqual({
      kind: 'untrusted',
      reason: 'Managed Codex home directory does not exist on disk.'
    })
  })

  it('still reports a genuinely absent marker as untrusted', () => {
    rmSync(marker)

    expect(probe()).toEqual({
      kind: 'untrusted',
      reason: 'Managed Codex home is missing Orca ownership marker.'
    })
  })

  it('refuses a symlinked marker even when its target holds the right account id', () => {
    const decoy = join(guestHome, 'decoy-marker')
    writeFileSync(decoy, `${ACCOUNT_ID}\n`, 'utf-8')
    rmSync(marker)
    symlinkSync(decoy, marker)

    expect(probe()).toEqual({
      kind: 'untrusted',
      reason: 'Managed Codex home ownership marker is not a regular file.'
    })
  })

  it('refuses a directory in the marker position', () => {
    rmSync(marker)
    mkdirSync(marker)

    expect(probe().kind).toBe('untrusted')
  })

  it('still reports a marker belonging to another account as untrusted', () => {
    writeFileSync(marker, 'someone-else\n', 'utf-8')

    expect(probe()).toEqual({
      kind: 'untrusted',
      reason: 'Managed WSL Codex home ownership marker does not match its account ID.'
    })
  })

  it('still reports a home outside the managed root as untrusted', () => {
    const stray = join(guestHome, 'elsewhere', 'home')
    mkdirSync(stray, { recursive: true })
    writeFileSync(join(stray, '.orca-managed-home'), `${ACCOUNT_ID}\n`, 'utf-8')
    candidate = stray

    expect(probe(undefined).kind).toBe('untrusted')
  })
})
