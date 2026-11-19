/**
 * Ownership for the [projects."<path>"] tables Orca's preflight trust writes:
 * a removed worktree's entry must die with the worktree, while a table that
 * existed at the path before Orca first wrote it stays the user's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markCodexProjectTrusted } from '../../../agent-launch/trust/agent-trust-presets'
import { removeOrcaCreatedProjectTrustEntries } from './codex-project-trust-worker-client'
import type * as TomlAtomicWrite from '../../configuration/toml/config-toml-atomic-write'

// Runs just before each config publication, between the grant's read and its write.
const beforePublish: { run: null | ((configPath: string) => void) } = vi.hoisted(() => ({
  run: null
}))

vi.mock('../../configuration/toml/config-toml-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof TomlAtomicWrite>()
  return {
    ...actual,
    writeTomlConfigAtomically: (...args: Parameters<typeof actual.writeTomlConfigAtomically>) => {
      beforePublish.run?.(args[0])
      return actual.writeTomlConfigAtomically(...args)
    }
  }
})

vi.mock('./codex-project-trust-worker-spawn', async () => ({
  spawnCodexProjectTrustWorker: (await import('./codex-project-trust-worker.test-fixture'))
    .codexProjectTrustTestWorker.factory
}))

const PROJECT = '/tmp/worktrees/feature-r1'
const OTHER = '/tmp/worktrees/other-r1'

describe('Orca-created project trust lifecycle', () => {
  let userDataDir: string
  let managedConfigPath: string
  let accountConfigPath: string
  let systemConfigPath: string
  let ledgerPath: string
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-pretrust-ownership-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = userDataDir
    const managedHome = join(userDataDir, 'codex-runtime-home', 'home')
    const accountHome = join(userDataDir, 'codex-accounts', 'acct-1', 'home')
    const systemHome = join(userDataDir, 'system-home', '.codex')
    for (const home of [managedHome, accountHome, systemHome]) {
      mkdirSync(home, { recursive: true })
    }
    managedConfigPath = join(managedHome, 'config.toml')
    accountConfigPath = join(accountHome, 'config.toml')
    systemConfigPath = join(systemHome, 'config.toml')
    ledgerPath = join(userDataDir, 'codex-project-trust-created.json')
  })

  afterEach(() => {
    beforePublish.run = null
    rmSync(userDataDir, { recursive: true, force: true })
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
  })

  function readLedger(): Record<string, { path: string; written: string }[]> {
    return JSON.parse(readFileSync(ledgerPath, 'utf-8')).created
  }

  it('removes the tables Orca created for a removed worktree, per account, and keeps other paths', async () => {
    await markCodexProjectTrusted(PROJECT, [managedConfigPath, accountConfigPath])
    await markCodexProjectTrusted(OTHER, [managedConfigPath])
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
    await markCodexProjectTrusted(PROJECT, [managedConfigPath])

    // …but the worktree removal must not delete the pre-existing tables.
    await removeOrcaCreatedProjectTrustEntries(PROJECT)

    expect(readFileSync(managedConfigPath, 'utf-8')).toBe(
      [`[projects."${PROJECT}"]`, 'trust_level = "trusted"', ''].join('\n')
    )
    expect(readFileSync(accountConfigPath, 'utf-8')).toBe(
      [`[projects."${PROJECT}"]`, 'trust_level = "untrusted"', ''].join('\n')
    )
  })

  it('does not delete a table the user replaced after Orca created the original', async () => {
    await markCodexProjectTrusted(PROJECT, [managedConfigPath])
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
  })

  it('writes nothing for a project every config already trusts', async () => {
    const trusted = ['model = "o3"', '', `[projects."${PROJECT}"]`, 'trust_level = "trusted"', '']
    for (const configPath of [managedConfigPath, systemConfigPath]) {
      writeFileSync(configPath, trusted.join('\n'))
    }

    await markCodexProjectTrusted(PROJECT, [managedConfigPath, systemConfigPath])

    for (const configPath of [managedConfigPath, systemConfigPath]) {
      expect(readFileSync(configPath, 'utf-8')).toBe(trusted.join('\n'))
      expect(existsSync(`${configPath}.bak`)).toBe(false)
    }
    expect(existsSync(ledgerPath)).toBe(false)
  })

  it('records a new grant in every config beside a fleet-sized ledger and configs', async () => {
    const configs = [managedConfigPath, accountConfigPath, systemConfigPath]
    const projectTables = Array.from(
      { length: 3_300 },
      (_, i) =>
        `[projects."/Users/me/orca/workspaces/repo/feature-${i}"]\ntrust_level = "trusted"\n`
    ).join('\n')
    for (const configPath of configs) {
      writeFileSync(configPath, projectTables)
    }
    const seeded: Record<string, { path: string; written: string }[]> = {}
    for (let i = 0; i < 2_856; i++) {
      const key = join(userDataDir, `seed-${i % 7}`, 'config.toml')
      ;(seeded[key] ??= []).push({ path: `/seed/${i}`, written: `[projects."/seed/${i}"]\n` })
    }
    writeFileSync(ledgerPath, JSON.stringify({ version: 1, created: seeded }))

    await markCodexProjectTrusted(PROJECT, configs)

    const ledger = readLedger()
    expect(Object.values(ledger).flat()).toHaveLength(2_859)
    for (const configPath of configs) {
      expect(readFileSync(configPath, 'utf-8')).toContain(`[projects."${PROJECT}"]`)
      expect(ledger[configPath]).toEqual([
        { path: PROJECT, written: `[projects."${PROJECT}"]\ntrust_level = "trusted"\n` }
      ])
    }
  })

  it('loses no ledger records across concurrent launches and removals', async () => {
    const configs = [managedConfigPath, accountConfigPath, systemConfigPath]
    const project = (i: number): string => `/tmp/worktrees/concurrent-${i}`
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => markCodexProjectTrusted(project(i), configs))
    )

    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => removeOrcaCreatedProjectTrustEntries(project(i))),
      ...Array.from({ length: 6 }, (_, i) => markCodexProjectTrusted(project(12 + i), configs))
    ])

    const ledger = readLedger()
    const expected = Array.from({ length: 12 }, (_, i) => project(6 + i))
    for (const configPath of configs) {
      expect(ledger[configPath].map((entry) => entry.path).sort()).toEqual([...expected].sort())
      const config = readFileSync(configPath, 'utf-8')
      for (const path of expected) {
        expect(config).toContain(`[projects."${path}"]`)
      }
      expect(config).not.toContain(`[projects."${project(0)}"]`)
    }
  })

  it('keeps an edit another writer publishes between the grant reading and replacing a config', async () => {
    writeFileSync(managedConfigPath, 'model = "o3"\n')
    beforePublish.run = (configPath) => {
      beforePublish.run = null
      writeFileSync(configPath, 'model = "gpt-5"\n')
    }

    await markCodexProjectTrusted(PROJECT, [managedConfigPath])

    const config = readFileSync(managedConfigPath, 'utf-8')
    expect(config).toContain('model = "gpt-5"')
    expect(config).not.toContain('model = "o3"')
    expect(config).toContain(`[projects."${PROJECT}"]`)
    expect(readLedger()[managedConfigPath]).toHaveLength(1)
  })

  it('records every table a grant creates before it publishes any config', async () => {
    let ledgerWhenSystemPublished: Record<string, unknown> | null = null
    beforePublish.run = (configPath) => {
      if (configPath === systemConfigPath) {
        ledgerWhenSystemPublished = readLedger()
      }
    }

    await markCodexProjectTrusted(PROJECT, [managedConfigPath, systemConfigPath])

    expect(Object.keys(ledgerWhenSystemPublished ?? {}).sort()).toEqual(
      [managedConfigPath, systemConfigPath].sort()
    )
    await removeOrcaCreatedProjectTrustEntries(PROJECT)
    for (const configPath of [managedConfigPath, systemConfigPath]) {
      expect(readFileSync(configPath, 'utf-8')).not.toContain(`[projects."${PROJECT}"]`)
    }
  })

  it('records a table a redo creates before it publishes the next config', async () => {
    writeFileSync(managedConfigPath, `[projects."${PROJECT}"]\ntrust_level = "untrusted"\n`)
    let ledgerWhenSystemPublished: Record<string, unknown> | null = null
    beforePublish.run = (configPath) => {
      if (configPath === managedConfigPath && ledgerWhenSystemPublished === null) {
        writeFileSync(managedConfigPath, 'model = "gpt-5"\n')
      }
      if (configPath === systemConfigPath) {
        ledgerWhenSystemPublished = readLedger()
      }
    }

    await markCodexProjectTrusted(PROJECT, [managedConfigPath, systemConfigPath])

    expect(Object.keys(ledgerWhenSystemPublished ?? {}).sort()).toEqual(
      [managedConfigPath, systemConfigPath].sort()
    )
    expect(readFileSync(managedConfigPath, 'utf-8')).toBe(
      `model = "gpt-5"\n\n[projects."${PROJECT}"]\ntrust_level = "trusted"\n`
    )
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps the records of configs written before a later config fails to publish',
    async () => {
      writeFileSync(systemConfigPath, 'model = "o3"\n')
      const systemHome = join(systemConfigPath, '..')
      chmodSync(systemHome, 0o500)
      try {
        await expect(
          markCodexProjectTrusted(PROJECT, [managedConfigPath, systemConfigPath])
        ).rejects.toThrow()
        expect(readFileSync(systemConfigPath, 'utf-8')).toBe('model = "o3"\n')
        expect(readdirSync(systemHome)).toEqual(['config.toml'])
      } finally {
        chmodSync(systemHome, 0o700)
      }
      expect(Object.keys(readLedger())).toEqual([managedConfigPath])

      await removeOrcaCreatedProjectTrustEntries(PROJECT)
      expect(readFileSync(managedConfigPath, 'utf-8')).not.toContain(`[projects."${PROJECT}"]`)
    }
  )
})
