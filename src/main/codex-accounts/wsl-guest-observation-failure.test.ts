import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

vi.mock('../wsl', () => ({
  toWindowsWslPath: (linuxPath: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
}))

import {
  buildWslCodexManagedHomeProbeScript,
  classifyWslCodexManagedHomeProbe
} from './wsl-codex-managed-home-probe'
import {
  buildWslManagedHomePreparationScript,
  WSL_PREPARE_INDETERMINATE_EXIT,
  WSL_PREPARE_MARKER_MISMATCH_EXIT,
  WSL_PREPARE_MARKER_MISSING_EXIT
} from './wsl-codex-managed-home-preparation'

/**
 * R2 review: a *failed* observation must never reach a dispositive answer. These
 * cases are all shell-level, so they run the real scripts. Two need a listing
 * that succeeds once and then disagrees with itself, which no fixture can
 * produce on a quiet filesystem — a shimmed `ls` earlier on PATH supplies it.
 */
const DISTRO = 'Ubuntu'
const ACCOUNT_ID = 'account-1'

describe.skipIf(process.platform === 'win32')('guest observation failures', () => {
  let guestHome: string
  let accountDir: string
  let candidate: string
  let marker: string
  let shimDir: string
  const sealed: string[] = []

  beforeEach(() => {
    guestHome = mkdtempSync(join(tmpdir(), 'orca-guest-fail-'))
    accountDir = join(guestHome, '.local', 'share', 'orca', 'codex-accounts', ACCOUNT_ID)
    candidate = join(accountDir, 'home')
    marker = join(candidate, '.orca-managed-home')
    shimDir = join(guestHome, 'shim-bin')
    mkdirSync(shimDir, { recursive: true })
    mkdirSync(candidate, { recursive: true })
    writeFileSync(marker, `${ACCOUNT_ID}\n`, 'utf-8')
    sealed.length = 0
  })

  afterEach(() => {
    for (const path of sealed) {
      try {
        chmodSync(path, 0o755)
      } catch {
        // already gone
      }
    }
    rmSync(guestHome, { recursive: true, force: true })
  })

  /**
   * An `ls` whose first call answers truthfully and whose later calls do not —
   * the shape of an EIO mid-listing, a SIGPIPE from `grep -q` closing early, or
   * a directory mutated between two listings.
   */
  function installDisagreeingLs(firstCallOutput: string): void {
    const counter = join(guestHome, 'ls-calls')
    writeFileSync(
      join(shimDir, 'ls'),
      [
        '#!/bin/sh',
        'case "$*" in',
        '  *-ld*) exec /bin/ls "$@" ;;',
        'esac',
        `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)`,
        'n=$((n+1))',
        `printf '%s' "$n" > ${JSON.stringify(counter)}`,
        'if [ "$n" = 1 ]; then',
        `  printf '%s\\n' ${JSON.stringify(firstCallOutput)}`,
        '  exit 0',
        'fi',
        'exit 0',
        ''
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 }
    )
  }

  function shimmedPath(): string {
    return `${shimDir}${delimiter}${process.env.PATH ?? ''}`
  }

  function probe(env: NodeJS.ProcessEnv = {}) {
    const script = buildWslCodexManagedHomeProbeScript(candidate, ACCOUNT_ID)
    try {
      const stdout = execFileSync('bash', ['-c', script], {
        encoding: 'utf-8',
        env: { ...process.env, HOME: guestHome, ...env },
        timeout: 20_000
      })
      return classifyWslCodexManagedHomeProbe({ ran: true, stdout }, DISTRO)
    } catch (error) {
      return classifyWslCodexManagedHomeProbe({ ran: false, error }, DISTRO)
    }
  }

  function prepare(env: NodeJS.ProcessEnv = {}): number {
    const result = spawnSync(
      'bash',
      ['-c', buildWslManagedHomePreparationScript(candidate, ACCOUNT_ID)],
      { encoding: 'utf-8', env: { ...process.env, HOME: guestHome, ...env }, timeout: 20_000 }
    )
    return result.status ?? -1
  }

  it('does not call a home absent when the listing that would prove it disagreed', () => {
    // The home is present but unstattable (ELOOP), so absence must be proved by
    // listing. A listing that reports the entry once and not again has not
    // proved anything.
    rmSync(candidate, { recursive: true })
    symlinkSync(join(accountDir, 'loop'), candidate)
    symlinkSync(candidate, join(accountDir, 'loop'))
    installDisagreeingLs('home')

    expect(probe({ PATH: shimmedPath() }).kind).toBe('indeterminate')
  })

  it('does not call a marker missing when the listing that would prove it disagreed', () => {
    // The marker is genuinely gone from disk, but the first listing reports it.
    // The two observations conflict, so nothing has been established.
    rmSync(marker)
    installDisagreeingLs('.orca-managed-home')

    const status = prepare({ PATH: shimmedPath() })

    expect(status).not.toBe(WSL_PREPARE_MARKER_MISSING_EXIT)
    expect(status).toBe(WSL_PREPARE_INDETERMINATE_EXIT)
  })

  it('does not call a marker foreign when its contents could not be read', () => {
    // The marker is a regular file holding the right account id; only the read
    // is denied. Exit 42 refuses re-auth, so this locks the user out.
    sealed.push(marker)
    chmodSync(marker, 0o000)

    const status = prepare()

    expect(status).not.toBe(WSL_PREPARE_MARKER_MISMATCH_EXIT)
    expect(status).toBe(WSL_PREPARE_INDETERMINATE_EXIT)
  })

  it('does not call a marker foreign when its contents could not be read, in the probe', () => {
    sealed.push(marker)
    chmodSync(marker, 0o000)

    expect(probe().kind).toBe('indeterminate')
  })
})
