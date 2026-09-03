import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import type { ClaudeCredentialReadResult } from './claude-credential-read-result'
import {
  migrateClaudeAccountsToScopedStore,
  PER_ACCOUNT_CLAUDE_STORE_MIGRATION_MARKER
} from './per-account-claude-store-migration'

const ID_KEYED = '{"claudeAiOauth":{"accessToken":"id-keyed"}}'
const CLI_OWNED = '{"claudeAiOauth":{"accessToken":"cli-owned"}}'

function account(id: string, runtime: 'host' | 'wsl' | undefined = 'host'): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: `/tmp/${id}/auth`,
    ...(runtime === undefined ? {} : { managedAuthRuntime: runtime })
  } as ClaudeManagedAccount
}

describe('migrateClaudeAccountsToScopedStore', () => {
  let metadataDir: string
  const originalPlatform = process.platform

  beforeEach(() => {
    metadataDir = mkdtempSync(join(tmpdir(), 'orca-claude-store-migration-'))
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  afterEach(() => {
    rmSync(metadataDir, { recursive: true, force: true })
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  /**
   * Models the two real media the destination is composed of, so a test can put a credential in
   * one and not the other. `readDestination` here mirrors the production composed read.
   */
  function createFakeStores(initial: {
    idKeyed?: Record<string, string>
    scopedKeychain?: Record<string, string>
    sameHomeFile?: Record<string, string>
  }) {
    const idKeyed: Record<string, string> = { ...initial.idKeyed }
    const scopedKeychain: Record<string, string> = { ...initial.scopedKeychain }
    const sameHomeFile: Record<string, string> = { ...initial.sameHomeFile }
    return {
      idKeyed,
      scopedKeychain,
      sameHomeFile,
      options: {
        readIdKeyedCredentials: async (id: string) => idKeyed[id] ?? null,
        readDestination: async (a: ClaudeManagedAccount): Promise<ClaudeCredentialReadResult> => {
          const value = scopedKeychain[a.id] ?? sameHomeFile[a.id] ?? null
          return value === null ? { kind: 'absent' } : { kind: 'present', credentialsJson: value }
        },
        writeDestination: async (a: ClaudeManagedAccount, c: string) => {
          scopedKeychain[a.id] = c
        }
      }
    }
  }

  function run(overrides: {
    accounts: ClaudeManagedAccount[]
    readIdKeyedCredentials?: (id: string) => Promise<string | null>
    readDestination?: (a: ClaudeManagedAccount) => Promise<ClaudeCredentialReadResult>
    writeDestination?: (a: ClaudeManagedAccount, c: string) => Promise<void>
  }) {
    return migrateClaudeAccountsToScopedStore({
      metadataDir,
      accounts: overrides.accounts,
      readIdKeyedCredentials: overrides.readIdKeyedCredentials ?? (async () => ID_KEYED),
      readDestination: overrides.readDestination ?? (async () => ({ kind: 'absent' })),
      writeDestination: overrides.writeDestination ?? (async () => {})
    })
  }

  it('copies the id-keyed value into an empty CLI-owned destination', async () => {
    const writeDestination = vi.fn(async () => {})
    const outcomes = await run({ accounts: [account('a')], writeDestination })
    expect(outcomes.get('a')).toBe('migrated')
    expect(writeDestination).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), ID_KEYED)
  })

  it('leaves the id-keyed source byte-identical after migrating', async () => {
    // Not a mock assertion: the fake store is real state, so a delete or rewrite of the source
    // anywhere in the migration shows up here. A read-back proves the destination holds what we
    // copied; it does not prove the source was unchanged meanwhile, so deleting on that evidence
    // can erase a rotation we never copied.
    const stores = createFakeStores({ idKeyed: { a: ID_KEYED } })
    await run({ accounts: [account('a')], ...stores.options })
    expect(stores.idKeyed.a).toBe(ID_KEYED)
  })

  it('does not overwrite a destination whose Keychain item already holds a credential', async () => {
    const stores = createFakeStores({
      idKeyed: { a: ID_KEYED },
      scopedKeychain: { a: CLI_OWNED }
    })
    const outcomes = await run({ accounts: [account('a')], ...stores.options })
    expect(outcomes.get('a')).toBe('already-present')
    expect(stores.scopedKeychain.a).toBe(CLI_OWNED)
  })

  it('does not overwrite when only the same-home FILE holds the credential', async () => {
    // The destination is COMPOSED: scoped Keychain item plus same-home `.credentials.json`. This
    // account has an empty Keychain item and a newer CLI rotation in the file, written during a
    // durable Keychain outage. Checking only the Keychain half sees "absent", writes our older
    // id-keyed copy, and the write-then-clear rule then deletes the newer token.
    //
    // Ablation: drop `sameHomeFile` from the composed destination read below and this goes red.
    const stores = createFakeStores({
      idKeyed: { a: ID_KEYED },
      sameHomeFile: { a: CLI_OWNED }
    })
    const outcomes = await run({ accounts: [account('a')], ...stores.options })
    expect(outcomes.get('a')).toBe('already-present')
    expect(stores.sameHomeFile.a).toBe(CLI_OWNED)
    expect(stores.scopedKeychain.a).toBeUndefined()
  })

  it('skips an account that is not on the isolated macOS lane', async () => {
    // Ablation: removing the lane check turns this red. A WSL or pre-isolation account has no
    // config-dir-scoped store, so deriving one from its path files the credential where nothing
    // reads it and the account reports signed out.
    const writeDestination = vi.fn(async () => {})
    const outcomes = await run({ accounts: [account('w', 'wsl')], writeDestination })
    expect(outcomes.get('w')).toBe('out-of-lane')
    expect(writeDestination).not.toHaveBeenCalled()
  })

  it('reports no-source rather than migrating when the id-keyed item is empty', async () => {
    const writeDestination = vi.fn(async () => {})
    const outcomes = await run({
      accounts: [account('a')],
      readIdKeyedCredentials: async () => null,
      writeDestination
    })
    expect(outcomes.get('a')).toBe('no-source')
    expect(writeDestination).not.toHaveBeenCalled()
  })

  it('reports unavailable, not no-source, when the destination cannot be read', async () => {
    const writeDestination = vi.fn(async () => {})
    const outcomes = await run({
      accounts: [account('a')],
      readDestination: async () => ({ kind: 'unavailable', reason: 'keychain-transient' }),
      writeDestination
    })
    expect(outcomes.get('a')).toBe('unavailable')
    expect(writeDestination).not.toHaveBeenCalled()
  })

  it('marks completion per account, so a second account is not stranded', async () => {
    // Ablation: replacing the per-account id set with a single global marker turns this red —
    // migrating A would stamp "done" and B would never migrate, reporting absent credentials
    // forever with no retry.
    const writes: string[] = []
    const accounts = [account('a'), account('b')]
    await run({ accounts, writeDestination: async (a) => void writes.push(a.id) })
    expect(writes).toEqual(['a', 'b'])

    const marker = JSON.parse(
      readFileSync(join(metadataDir, PER_ACCOUNT_CLAUDE_STORE_MIGRATION_MARKER), 'utf-8')
    ) as { completedAccountIds: string[] }
    expect(new Set(marker.completedAccountIds)).toEqual(new Set(['a', 'b']))
  })

  it('does not record an account that failed, so it retries next start', async () => {
    const accounts = [account('a')]
    await run({
      accounts,
      readDestination: async () => ({ kind: 'unavailable', reason: 'keychain-transient' })
    })
    const secondRun = vi.fn(async () => {})
    const outcomes = await run({ accounts, writeDestination: secondRun })
    expect(outcomes.get('a')).toBe('migrated')
    expect(secondRun).toHaveBeenCalledOnce()
  })

  it('does not re-migrate an account already recorded complete', async () => {
    const accounts = [account('a')]
    await run({ accounts })
    const writeDestination = vi.fn(async () => {})
    const outcomes = await run({ accounts, writeDestination })
    expect(outcomes.has('a')).toBe(false)
    expect(writeDestination).not.toHaveBeenCalled()
  })
})
