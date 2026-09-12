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
import {
  isUnprovenManagedClaudeAuthError,
  ManagedClaudeAuthTemporarilyUnavailableError,
  MISSING_MANAGED_AUTH_MESSAGE,
  OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE,
  UntrustedManagedClaudeAuthError,
  UNTRUSTED_MANAGED_AUTH_MESSAGE
} from './claude-managed-auth-ownership'

vi.mock('../wsl', () => ({
  toWindowsWslPath: (linuxPath: string) => `\\\\wsl$\\Ubuntu${linuxPath}`
}))

import {
  buildWslManagedAuthProbeScript,
  classifyWslManagedAuthProbe
} from './wsl-managed-auth-probe'

const TAG = 'ORCA_CLAUDE_AUTH_VERDICT:'
const GUEST_PATH = '/home/dev/.local/share/orca/claude-accounts/acct-1/auth'

function probe(overrides: Partial<Parameters<typeof classifyWslManagedAuthProbe>[0]> = {}) {
  return classifyWslManagedAuthProbe(
    { environmentResolved: true, code: 0, stdout: '', stderr: '', timedOut: false, ...overrides },
    'Ubuntu'
  )
}

function ownedTag(path: string) {
  return `${TAG}owned:${Buffer.from(path, 'utf-8').toString('base64')}\n`
}

describe('WSL Claude managed-auth probe classification', () => {
  it('reports a completed guest observation as the verdict it names', () => {
    expect(probe({ stdout: ownedTag(GUEST_PATH) })).toEqual({
      kind: 'owned',
      authPath: `\\\\wsl$\\Ubuntu${GUEST_PATH}`
    })
    expect(probe({ stdout: `${TAG}missing-marker\n` })).toEqual({
      kind: 'untrusted',
      reason: MISSING_MANAGED_AUTH_MESSAGE
    })
    expect(probe({ stdout: `${TAG}marker-mismatch\n` })).toEqual({
      kind: 'untrusted',
      reason: UNTRUSTED_MANAGED_AUTH_MESSAGE
    })
    expect(probe({ stdout: `${TAG}outside-managed-root\n` })).toEqual({
      kind: 'untrusted',
      reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE
    })
    expect(probe({ stdout: `${TAG}missing-directory\n` })).toEqual({
      kind: 'untrusted',
      reason: MISSING_MANAGED_AUTH_MESSAGE
    })
    for (const tag of [
      'marker-not-a-file',
      'marker-is-symlink',
      'candidate-is-symlink',
      'not-a-directory'
    ]) {
      expect(probe({ stdout: `${TAG}${tag}\n` })).toEqual({
        kind: 'untrusted',
        reason: UNTRUSTED_MANAGED_AUTH_MESSAGE
      })
    }
  })

  it('survives a guest path containing a colon and CRLF line endings', () => {
    const oddPath = '/home/de:v/.local/share/orca/claude-accounts/acct-1/auth'
    expect(probe({ stdout: `${ownedTag(oddPath).trimEnd()}\r\n` })).toEqual({
      kind: 'owned',
      authPath: `\\\\wsl$\\Ubuntu${oddPath}`
    })
  })

  // Each of these used to be reported as a trust or absence verdict, which is
  // what let a cold distro read as "this is not your auth directory".
  it.each([
    ['a timeout', { timedOut: true, code: null, stdout: '' }],
    ['a timeout that still reported exit 0', { timedOut: true, code: 0, stdout: '' }],
    ['an unresolved distro environment', { environmentResolved: false }],
    ['a non-zero exit', { code: 1, stdout: '' }],
    ['a non-zero exit that printed a verdict', { code: 1, stdout: `${TAG}missing-marker\n` }],
    ['no verdict at all', { stdout: 'bash: base64: command not found\n' }],
    ['empty output', { stdout: '' }],
    ['more than one verdict', { stdout: `${TAG}missing-marker\n${TAG}outside-managed-root\n` }],
    ['a verdict that is not the last line', { stdout: `${TAG}missing-marker\ntrailing\n` }],
    ['an unknown verdict', { stdout: `${TAG}sideways\n` }],
    ['an undecodable owned path', { stdout: `${TAG}owned:!!!not-base64!!!\n` }],
    ['an owned verdict with no path', { stdout: `${TAG}owned:\n` }]
  ])('reports %s as indeterminate', (_label, overrides) => {
    expect(probe(overrides).kind).toBe('indeterminate')
  })

  it('builds a guest script that quotes its inputs and never relies on set -e for meaning', () => {
    const script = buildWslManagedAuthProbeScript(GUEST_PATH, "acct'1")
    expect(script).toContain(`candidate='${GUEST_PATH}'`)
    expect(script).toContain(`test "$contents" = 'acct'\\''1'`)
    expect(script.split('\n')[0]).toBe('set -uo pipefail')
    // Without an expected account ID the marker only has to be non-empty.
    expect(buildWslManagedAuthProbeScript(GUEST_PATH)).toContain('test -n "$contents"')
  })
})

describe('Claude managed-auth error vocabulary', () => {
  it('recognises an unproven failure through a chain of causes', () => {
    const unavailable = new ManagedClaudeAuthTemporarilyUnavailableError()
    expect(isUnprovenManagedClaudeAuthError(unavailable)).toBe(true)
    expect(isUnprovenManagedClaudeAuthError(new Error('wrapped', { cause: unavailable }))).toBe(
      true
    )
    expect(
      isUnprovenManagedClaudeAuthError(
        new Error('outer', { cause: new Error('inner', { cause: unavailable }) })
      )
    ).toBe(true)
  })

  it('does not mistake a proven trust failure, or anything else, for an unproven one', () => {
    expect(isUnprovenManagedClaudeAuthError(new UntrustedManagedClaudeAuthError('nope'))).toBe(
      false
    )
    expect(isUnprovenManagedClaudeAuthError(new Error('login failed'))).toBe(false)
    expect(isUnprovenManagedClaudeAuthError(null)).toBe(false)
    expect(isUnprovenManagedClaudeAuthError('temporarily locked')).toBe(false)
  })

  it('recognises the typed error through a non-Error wrapper', () => {
    // An IPC or dependency boundary can reject with a plain object; the payload
    // is still the only evidence of whether the observation completed.
    expect(
      isUnprovenManagedClaudeAuthError({
        cause: new ManagedClaudeAuthTemporarilyUnavailableError()
      })
    ).toBe(true)
  })

  it('treats a shape it cannot inspect as unproven rather than as a clean failure', () => {
    const hostile = {
      get cause(): unknown {
        throw new Error('nope')
      }
    }
    expect(isUnprovenManagedClaudeAuthError(hostile)).toBe(true)
  })

  it('treats a Proxy that rejects prototype inspection as unproven', () => {
    const hostile = new Proxy(new Error('wrapped'), {
      getPrototypeOf() {
        throw new Error('nope')
      },
      get() {
        throw new Error('nope')
      }
    })
    expect(isUnprovenManagedClaudeAuthError(hostile)).toBe(true)
  })

  it('treats a chain longer than the inspection depth as unproven', () => {
    // The links past the cap were never looked at, so nothing about them is
    // proven -- unlike a cycle, where every reachable link has been seen.
    let chain: unknown = new ManagedClaudeAuthTemporarilyUnavailableError()
    for (let i = 0; i < 12; i += 1) {
      chain = new Error(`layer ${i}`, { cause: chain })
    }
    expect(isUnprovenManagedClaudeAuthError(chain)).toBe(true)
  })

  it('terminates on a self-referential cause chain, and answers it', () => {
    // A cycle is a completed inspection: every reachable link was visited.
    const looping = new Error('loop') as Error & { cause?: unknown }
    looping.cause = looping
    expect(isUnprovenManagedClaudeAuthError(looping)).toBe(false)
  })
})

/**
 * The script runs in the guest, so the only honest way to pin what it reports is
 * to run it. `test -f` returns false for an unsearchable directory exactly as it
 * does for an empty one, and that indistinguishability is the bug this covers.
 */
function bashCanRunTheProbe(): boolean {
  try {
    execFileSync('bash', ['-c', 'readlink -f -- / >/dev/null && command -v base64 >/dev/null'], {
      stdio: 'ignore'
    })
    // A root-owned run ignores mode bits, so the permission cases would not deny.
    return process.getuid?.() !== 0
  } catch {
    return false
  }
}

describe.skipIf(!bashCanRunTheProbe())('WSL guest probe script, executed by bash', () => {
  let guestHome = ''
  const ACCOUNT = 'acct-1'

  function authPathFor(accountId = ACCOUNT): string {
    return join(guestHome, '.local/share/orca/claude-accounts', accountId, 'auth')
  }

  function runProbe(candidate: string, expectedAccountId: string | undefined = ACCOUNT) {
    const script = buildWslManagedAuthProbeScript(candidate, expectedAccountId)
    try {
      const stdout = execFileSync('bash', ['-c', script], {
        env: { ...process.env, HOME: guestHome },
        encoding: 'utf-8'
      })
      return classifyWslManagedAuthProbe(
        { environmentResolved: true, code: 0, stdout, stderr: '', timedOut: false },
        'Ubuntu'
      )
    } catch (error) {
      const failure = error as { status?: number; stdout?: string }
      return classifyWslManagedAuthProbe(
        {
          environmentResolved: true,
          code: failure.status ?? 1,
          stdout: failure.stdout ?? '',
          stderr: '',
          timedOut: false
        },
        'Ubuntu'
      )
    }
  }

  beforeEach(() => {
    guestHome = mkdtempSync(join(tmpdir(), 'sta5674-guest-script-'))
    const authPath = authPathFor()
    mkdirSync(authPath, { recursive: true })
    writeFileSync(join(authPath, '.orca-managed-claude-auth'), `${ACCOUNT}\n`)
  })

  afterEach(() => {
    // Restore search permission first, or the cleanup cannot descend either.
    try {
      chmodSync(authPathFor(), 0o700)
    } catch {
      // The case under test may have removed the directory.
    }
    rmSync(guestHome, { recursive: true, force: true })
  })

  it('proves ownership of a real marker under the managed root', () => {
    // The guest reports the canonical spelling, which is what the caller stores.
    expect(runProbe(authPathFor())).toEqual({
      kind: 'owned',
      authPath: `\\\\wsl$\\Ubuntu${realpathSync(authPathFor())}`
    })
  })

  it('reports a directory it cannot search as indeterminate, not as a missing marker', () => {
    chmodSync(authPathFor(), 0o000)
    expect(runProbe(authPathFor()).kind).toBe('indeterminate')
  })

  it('reports a marker it cannot read as indeterminate', () => {
    chmodSync(join(authPathFor(), '.orca-managed-claude-auth'), 0o000)
    expect(runProbe(authPathFor()).kind).toBe('indeterminate')
  })

  it('reports a genuinely absent marker as a dispositive absence', () => {
    rmSync(join(authPathFor(), '.orca-managed-claude-auth'))
    expect(runProbe(authPathFor())).toEqual({
      kind: 'untrusted',
      reason: MISSING_MANAGED_AUTH_MESSAGE
    })
  })

  it('refuses a candidate that is a file rather than a directory', () => {
    const authPath = authPathFor()
    rmSync(authPath, { recursive: true })
    writeFileSync(authPath, 'not a directory')
    expect(runProbe(authPath)).toEqual({
      kind: 'untrusted',
      reason: UNTRUSTED_MANAGED_AUTH_MESSAGE
    })
  })

  it('never reports a dispositive verdict for an absent directory it could not resolve', () => {
    // GNU `readlink -f` tolerates one missing trailing component and reaches the
    // `missing-directory` tag; BSD and BusyBox fail outright, which exits 1.
    // Both land on a refusal — the point is that neither invents a trust verdict.
    rmSync(authPathFor(), { recursive: true })
    const verdict = runProbe(authPathFor())
    expect(verdict.kind === 'indeterminate' || verdict.kind === 'untrusted').toBe(true)
    if (verdict.kind === 'untrusted') {
      expect(verdict.reason).toBe(MISSING_MANAGED_AUTH_MESSAGE)
    }
  })

  it('refuses a marker naming another account', () => {
    writeFileSync(join(authPathFor(), '.orca-managed-claude-auth'), 'someone-else\n')
    expect(runProbe(authPathFor())).toEqual({
      kind: 'untrusted',
      reason: UNTRUSTED_MANAGED_AUTH_MESSAGE
    })
  })

  it('refuses a symlinked marker', () => {
    const authPath = authPathFor()
    rmSync(join(authPath, '.orca-managed-claude-auth'))
    writeFileSync(join(authPath, 'real-marker'), `${ACCOUNT}\n`)
    symlinkSync('real-marker', join(authPath, '.orca-managed-claude-auth'))
    expect(runProbe(authPath)).toEqual({
      kind: 'untrusted',
      reason: UNTRUSTED_MANAGED_AUTH_MESSAGE
    })
  })

  it('refuses a symlinked candidate that resolves to a valid auth directory', () => {
    // Separate fixture on purpose: with the marker also symlinked, this passes
    // on the marker check alone and says nothing about the candidate check.
    const linkedCandidate = join(guestHome, '.local/share/orca/claude-accounts', ACCOUNT, 'link')
    symlinkSync(authPathFor(), linkedCandidate)
    expect(runProbe(linkedCandidate)).toEqual({
      kind: 'untrusted',
      reason: UNTRUSTED_MANAGED_AUTH_MESSAGE
    })
  })

  it('refuses a nested account path that merely shares the suffix', () => {
    // `<root>/other/acct/auth` is not `<root>/acct/auth`; a shell `*` matched it.
    const nested = join(guestHome, '.local/share/orca/claude-accounts/other', ACCOUNT, 'auth')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, '.orca-managed-claude-auth'), `${ACCOUNT}\n`)
    expect(runProbe(nested)).toEqual({
      kind: 'untrusted',
      reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE
    })
  })

  it('refuses a directory outside the managed root', () => {
    const outside = join(guestHome, 'elsewhere/auth')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, '.orca-managed-claude-auth'), `${ACCOUNT}\n`)
    expect(runProbe(outside)).toEqual({
      kind: 'untrusted',
      reason: OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE
    })
  })
})
