import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWslManagedHomePreparationScript,
  WSL_PREPARE_INDETERMINATE_EXIT,
  WSL_PREPARE_MARKER_MISMATCH_EXIT,
  WSL_PREPARE_MARKER_MISSING_EXIT,
  WSL_PREPARE_MARKER_NOT_REGULAR_EXIT
} from './wsl-codex-managed-home-preparation'

/**
 * The preparation script WRITES, and only exits 41/42/43 may be read as a trust
 * verdict. Running it for real is the only way to pin that: mocking the runner
 * asserts the mapping while leaving the script itself unexercised.
 */
const ACCOUNT_ID = 'account-1'

describe.skipIf(process.platform === 'win32')('WSL managed home preparation script', () => {
  let root: string
  let candidate: string
  let marker: string
  const sealed: string[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-wsl-prepare-'))
    candidate = join(root, '.local', 'share', 'orca', 'codex-accounts', ACCOUNT_ID, 'home')
    marker = join(candidate, '.orca-managed-home')
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
    rmSync(root, { recursive: true, force: true })
  })

  function prepare(): number {
    const result = spawnSync(
      'bash',
      ['-c', buildWslManagedHomePreparationScript(candidate, ACCOUNT_ID)],
      { encoding: 'utf-8', timeout: 20_000 }
    )
    return result.status ?? -1
  }

  it('creates the home and marker on a first run', () => {
    expect(prepare()).toBe(0)
    expect(readFileSync(marker, 'utf-8')).toBe(`${ACCOUNT_ID}\n`)
  })

  it('is idempotent over an already-prepared home', () => {
    expect(prepare()).toBe(0)
    expect(prepare()).toBe(0)
    expect(readFileSync(marker, 'utf-8')).toBe(`${ACCOUNT_ID}\n`)
  })

  it('refuses a symlinked marker and does not write through it', () => {
    const decoy = join(root, 'decoy')
    writeFileSync(decoy, 'untouched\n', 'utf-8')
    mkdirSync(candidate, { recursive: true })
    symlinkSync(decoy, marker)

    expect(prepare()).toBe(WSL_PREPARE_MARKER_NOT_REGULAR_EXIT)
    expect(readFileSync(decoy, 'utf-8')).toBe('untouched\n')
    expect(lstatSync(marker).isSymbolicLink()).toBe(true)
  })

  it('refuses a directory in the marker position', () => {
    mkdirSync(marker, { recursive: true })

    expect(prepare()).toBe(WSL_PREPARE_MARKER_NOT_REGULAR_EXIT)
  })

  it('refuses an existing home that has no marker', () => {
    mkdirSync(candidate, { recursive: true })

    expect(prepare()).toBe(WSL_PREPARE_MARKER_MISSING_EXIT)
  })

  it('refuses a home marked for another account', () => {
    mkdirSync(candidate, { recursive: true })
    writeFileSync(marker, 'someone-else\n', 'utf-8')

    expect(prepare()).toBe(WSL_PREPARE_MARKER_MISMATCH_EXIT)
  })

  it('reports "could not tell" rather than a foreign home when it cannot list', () => {
    // A present home Orca simply cannot read must not exit 41 — re-auth refuses
    // on 41, so that would lock the user out of their own account.
    mkdirSync(candidate, { recursive: true })
    writeFileSync(marker, `${ACCOUNT_ID}\n`, 'utf-8')
    sealed.push(candidate)
    chmodSync(candidate, 0o000)

    const status = prepare()

    expect(status).not.toBe(WSL_PREPARE_MARKER_MISSING_EXIT)
    expect(status).not.toBe(WSL_PREPARE_MARKER_MISMATCH_EXIT)
    expect(status).not.toBe(WSL_PREPARE_MARKER_NOT_REGULAR_EXIT)
    expect(status).not.toBe(0)
  })

  it('reports "could not tell" when the marker is listed but unreadable', () => {
    mkdirSync(candidate, { recursive: true })
    writeFileSync(marker, `${ACCOUNT_ID}\n`, 'utf-8')
    sealed.push(candidate)
    chmodSync(candidate, 0o444) // readable (listable) but not searchable

    expect(prepare()).toBe(WSL_PREPARE_INDETERMINATE_EXIT)
  })

  it('leaves nothing behind when it refuses', () => {
    mkdirSync(candidate, { recursive: true })
    writeFileSync(marker, 'someone-else\n', 'utf-8')

    prepare()

    expect(readFileSync(marker, 'utf-8')).toBe('someone-else\n')
    expect(existsSync(join(candidate, '.orca-managed-home.tmp'))).toBe(false)
  })
})
