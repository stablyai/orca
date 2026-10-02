/**
 * Ownership for the [projects."<path>"] tables Orca's preflight trust writes:
 * a removed worktree's entry must die with the worktree, while a table that
 * existed at the path before Orca first wrote it stays the user's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  removeOrcaCreatedProjectTrustEntries,
  upsertOrcaCreatedProjectTrustLevel
} from './config-toml-trust'

const PROJECT = '/tmp/worktrees/feature-r1'
const OTHER = '/tmp/worktrees/other-r1'

describe('Orca-created project trust lifecycle', () => {
  let userDataDir: string
  let managedConfigPath: string
  let accountConfigPath: string
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-pretrust-ownership-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = userDataDir
    const managedHome = join(userDataDir, 'codex-runtime-home', 'home')
    const accountHome = join(userDataDir, 'codex-accounts', 'acct-1', 'home')
    mkdirSync(managedHome, { recursive: true })
    mkdirSync(accountHome, { recursive: true })
    managedConfigPath = join(managedHome, 'config.toml')
    accountConfigPath = join(accountHome, 'config.toml')
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
  })

  it('removes the tables Orca created for a removed worktree, per account, and keeps other paths', async () => {
    upsertOrcaCreatedProjectTrustLevel(managedConfigPath, PROJECT, 'trusted')
    upsertOrcaCreatedProjectTrustLevel(accountConfigPath, PROJECT, 'trusted')
    upsertOrcaCreatedProjectTrustLevel(managedConfigPath, OTHER, 'trusted')
    expect(readFileSync(managedConfigPath, 'utf-8')).toContain(`[projects."${PROJECT}"]`)

    await removeOrcaCreatedProjectTrustEntries(PROJECT)

    for (const configPath of [managedConfigPath, accountConfigPath]) {
      expect(readFileSync(configPath, 'utf-8')).not.toContain(`[projects."${PROJECT}"]`)
    }
    expect(readFileSync(managedConfigPath, 'utf-8')).toContain(`[projects."${OTHER}"]`)
    // The record was forgotten, so removing again cannot touch surviving entries.
    await removeOrcaCreatedProjectTrustEntries(PROJECT)
    expect(readFileSync(managedConfigPath, 'utf-8')).toContain(`[projects."${OTHER}"]`)
  })

  it('keeps a table that existed at the path before Orca wrote it', async () => {
    const userTable = [`[projects."${PROJECT}"]`, 'trust_level = "untrusted"', ''].join('\n')
    writeFileSync(managedConfigPath, userTable)
    writeFileSync(accountConfigPath, userTable)

    // The preflight grant still rewrites the trust line it always did…
    upsertOrcaCreatedProjectTrustLevel(managedConfigPath, PROJECT, 'trusted')

    // …but the worktree removal must not delete the pre-existing tables.
    await removeOrcaCreatedProjectTrustEntries(PROJECT)

    expect(readFileSync(managedConfigPath, 'utf-8')).toBe(
      [`[projects."${PROJECT}"]`, 'trust_level = "trusted"', ''].join('\n')
    )
    expect(readFileSync(accountConfigPath, 'utf-8')).toBe(
      [`[projects."${PROJECT}"]`, 'trust_level = "untrusted"', ''].join('\n')
    )
  })

  it('leaves entries with no ownership record (older Orca builds) untouched', async () => {
    const legacyTable = [`[projects."${PROJECT}"]`, 'trust_level = "trusted"', ''].join('\n')
    writeFileSync(managedConfigPath, legacyTable)

    await removeOrcaCreatedProjectTrustEntries(PROJECT)

    expect(readFileSync(managedConfigPath, 'utf-8')).toBe(legacyTable)
  })

  it('forgets the record once the config file itself is gone, so a rebuilt path is never purged', async () => {
    upsertOrcaCreatedProjectTrustLevel(managedConfigPath, PROJECT, 'trusted')
    rmSync(managedConfigPath)

    await expect(removeOrcaCreatedProjectTrustEntries(PROJECT)).resolves.toBeUndefined()

    const ledger = readFileSync(join(userDataDir, 'codex-project-trust-created.json'), 'utf-8')
    expect(ledger).not.toContain(PROJECT)
  })

  it('treats a malformed ledger as empty and never deletes on its say-so', async () => {
    upsertOrcaCreatedProjectTrustLevel(managedConfigPath, PROJECT, 'trusted')
    const ledgerPath = join(userDataDir, 'codex-project-trust-created.json')
    const malformedLedgers = [
      '{"created": null}',
      '{"created": []}',
      '{"created": {"cfg.toml": "not-an-array"}}',
      '{"created": {"cfg.toml": [42]}}',
      `{"created": {"cfg.toml": [{"path": "${PROJECT}"}]}}`,
      'not json'
    ]

    for (const malformed of malformedLedgers) {
      writeFileSync(ledgerPath, malformed)
      await expect(removeOrcaCreatedProjectTrustEntries(PROJECT)).resolves.toBeUndefined()
      expect(readFileSync(managedConfigPath, 'utf-8')).toContain(`[projects."${PROJECT}"]`)
    }
  })

  it('does not delete a table the user replaced after Orca created the original', async () => {
    upsertOrcaCreatedProjectTrustLevel(managedConfigPath, PROJECT, 'trusted')
    const replacement = [
      `[projects."${PROJECT}"]`,
      'trust_level = "trusted"',
      'followup = "user-added"',
      ''
    ].join('\n')
    writeFileSync(managedConfigPath, replacement)

    await removeOrcaCreatedProjectTrustEntries(PROJECT)

    expect(readFileSync(managedConfigPath, 'utf-8')).toBe(replacement)
    // The spent record is dropped, so a later pass cannot delete the user's table either.
    await removeOrcaCreatedProjectTrustEntries(PROJECT)
    expect(readFileSync(managedConfigPath, 'utf-8')).toBe(replacement)
    const ledger = readFileSync(join(userDataDir, 'codex-project-trust-created.json'), 'utf-8')
    expect(ledger).not.toContain(PROJECT)
  })

  it('treats a trust line rewritten after the grant as a table Orca no longer owns', async () => {
    upsertOrcaCreatedProjectTrustLevel(managedConfigPath, PROJECT, 'trusted')
    const rewritten = [`[projects."${PROJECT}"]`, 'trust_level = "untrusted"', ''].join('\n')
    writeFileSync(managedConfigPath, rewritten)

    await removeOrcaCreatedProjectTrustEntries(PROJECT)

    expect(readFileSync(managedConfigPath, 'utf-8')).toBe(rewritten)
  })
})
