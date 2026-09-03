import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  LEGACY_SHARED_CLAUDE_AUTH_MIGRATION_MARKER,
  migrateLegacySharedClaudeAuth
} from './legacy-shared-claude-auth-migration'

const ownership = vi.hoisted(() => ({
  resolve: (_id: string, path: string): string | null => path
}))

vi.mock('./managed-auth-path', () => ({
  resolveOwnedClaudeManagedAuthPath: (id: string, path: string) => ownership.resolve(id, path)
}))

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-claude-migration-'))
  ownership.resolve = (_id, path) => path
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('legacy shared Claude auth migration', () => {
  it('uses runtime oauth identity when measured credentials contain no email', async () => {
    const fixture = createFixture()
    const writeManagedCredentials = vi.fn(async () => {})

    const outcome = await fixture.migrate({
      readLegacyOauthAccount: () => ({ emailAddress: 'user@example.com' }),
      writeManagedCredentials
    })

    expect(outcome).toBe('migrated')
    expect(writeManagedCredentials).toHaveBeenCalledWith(fixture.account, fixture.shared)
    expect(fixture.marker()).toMatchObject({ outcome: 'migrated', accountId: fixture.account.id })
  })

  it('leaves ambiguous matching accounts unmodified and unmarked', async () => {
    const fixture = createFixture()
    const duplicate = { ...fixture.account, id: 'account-2' }
    const writeManagedCredentials = vi.fn(async () => {})

    const outcome = await fixture.migrate({
      accounts: [fixture.account, duplicate],
      readLegacyOauthAccount: () => ({ emailAddress: 'user@example.com' }),
      writeManagedCredentials
    })

    expect(outcome).toBe('ambiguous')
    expect(writeManagedCredentials).not.toHaveBeenCalled()
    expect(existsSync(fixture.markerPath)).toBe(false)
  })

  it('retries after a failed managed write and stamps only after success', async () => {
    const fixture = createFixture()
    const writeManagedCredentials = vi
      .fn<(account: ClaudeManagedAccount, contents: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('injected write failure'))
      .mockResolvedValueOnce()
    const options = {
      readLegacyOauthAccount: () => ({ emailAddress: 'user@example.com' }),
      writeManagedCredentials
    }

    await expect(fixture.migrate(options)).resolves.toBe('unavailable')
    expect(existsSync(fixture.markerPath)).toBe(false)
    await expect(fixture.migrate(options)).resolves.toBe('migrated')
    expect(writeManagedCredentials).toHaveBeenCalledTimes(2)
  })

  it('does not read or write credentials after the marker exists', async () => {
    const fixture = createFixture()
    mkdirSync(join(root, 'metadata'), { recursive: true })
    writeFileSync(fixture.markerPath, '{}\n', 'utf-8')
    const readLegacyKeychain = vi.fn(async () => fixture.shared)
    const writeManagedCredentials = vi.fn(async () => {})

    const outcome = await fixture.migrate({ readLegacyKeychain, writeManagedCredentials })

    expect(outcome).toBe('already-present')
    expect(readLegacyKeychain).not.toHaveBeenCalled()
    expect(writeManagedCredentials).not.toHaveBeenCalled()
  })

  it('preserves an existing managed credential and stamps a conclusive outcome', async () => {
    const fixture = createFixture()
    const writeManagedCredentials = vi.fn(async () => {})

    const outcome = await fixture.migrate({
      readLegacyOauthAccount: () => ({ emailAddress: 'user@example.com' }),
      readManagedCredentials: async () => 'existing',
      writeManagedCredentials
    })

    expect(outcome).toBe('already-present')
    expect(writeManagedCredentials).not.toHaveBeenCalled()
    expect(fixture.marker()).toMatchObject({ outcome: 'already-present' })
  })

  it('refuses an untrusted account home without reading or mutating the shared store', async () => {
    const fixture = createFixture()
    const readLegacyKeychain = vi.fn(async () => fixture.shared)
    const writeManagedCredentials = vi.fn(async () => {})
    ownership.resolve = () => null

    const outcome = await fixture.migrate({ readLegacyKeychain, writeManagedCredentials })

    expect(outcome).toBe('unavailable')
    expect(readLegacyKeychain).not.toHaveBeenCalled()
    expect(writeManagedCredentials).not.toHaveBeenCalled()
    expect(existsSync(fixture.markerPath)).toBe(false)
  })

  it('migrates the active account even when another account home is stale or deleted', async () => {
    const fixture = createFixture()
    const stale = {
      ...fixture.account,
      id: 'account-2',
      email: 'other@example.com',
      managedAuthPath: join(root, 'account-2', 'auth')
    }
    ownership.resolve = (id, path) => (id === stale.id ? null : path)
    const writeManagedCredentials = vi.fn(async () => {})

    const outcome = await fixture.migrate({
      accounts: [fixture.account, stale],
      readLegacyOauthAccount: () => ({ emailAddress: 'user@example.com' }),
      writeManagedCredentials
    })

    expect(outcome).toBe('migrated')
    expect(writeManagedCredentials).toHaveBeenCalledWith(fixture.account, fixture.shared)
    expect(fixture.marker()).toMatchObject({ outcome: 'migrated', accountId: fixture.account.id })
  })

  it('keeps a deleted-home duplicate identity in the ambiguity gate', async () => {
    const fixture = createFixture()
    const duplicate = {
      ...fixture.account,
      id: 'account-2',
      managedAuthPath: join(root, 'account-2', 'auth')
    }
    ownership.resolve = (id, path) => (id === duplicate.id ? null : path)
    const writeManagedCredentials = vi.fn(async () => {})

    const outcome = await fixture.migrate({
      accounts: [fixture.account, duplicate],
      readLegacyOauthAccount: () => ({ emailAddress: 'user@example.com' }),
      writeManagedCredentials
    })

    expect(outcome).toBe('ambiguous')
    expect(writeManagedCredentials).not.toHaveBeenCalled()
    expect(existsSync(fixture.markerPath)).toBe(false)
  })

  it('never clobbers a newer per-account credential', async () => {
    const fixture = createFixture()
    const newer = JSON.stringify({ claudeAiOauth: { accessToken: 'newer-token' } })
    const writeManagedCredentials = vi.fn(async () => {})

    const outcome = await fixture.migrate({
      readLegacyOauthAccount: () => ({ emailAddress: 'user@example.com' }),
      readManagedCredentials: async () => newer,
      writeManagedCredentials
    })

    expect(outcome).toBe('already-present')
    expect(writeManagedCredentials).not.toHaveBeenCalled()
    expect(fixture.marker()).toMatchObject({
      outcome: 'already-present',
      accountId: fixture.account.id
    })
  })

  it('is a full no-op once the generation marker is present', async () => {
    const fixture = createFixture()
    mkdirSync(join(root, 'metadata'), { recursive: true })
    writeFileSync(
      fixture.markerPath,
      `${JSON.stringify({ version: 1, completedAt: 1, outcome: 'migrated', accountId: fixture.account.id })}\n`,
      'utf-8'
    )
    const readLegacyKeychain = vi.fn(async () => fixture.shared)
    const readLegacyOauthAccount = vi.fn(() => ({ emailAddress: 'user@example.com' }))
    const readManagedCredentials = vi.fn(async () => null)
    const writeManagedCredentials = vi.fn(async () => {})

    const outcome = await fixture.migrate({
      readLegacyKeychain,
      readLegacyOauthAccount,
      readManagedCredentials,
      writeManagedCredentials
    })

    expect(outcome).toBe('already-present')
    expect(readLegacyKeychain).not.toHaveBeenCalled()
    expect(readLegacyOauthAccount).not.toHaveBeenCalled()
    expect(readManagedCredentials).not.toHaveBeenCalled()
    expect(writeManagedCredentials).not.toHaveBeenCalled()
  })

  it('never leaks the shared store to a non-matching account', async () => {
    const fixture = createFixture()
    const writeManagedCredentials = vi.fn(async () => {})

    const outcome = await fixture.migrate({
      readLegacyOauthAccount: () => ({ emailAddress: 'other@example.com' }),
      writeManagedCredentials
    })

    expect(outcome).toBe('ambiguous')
    expect(writeManagedCredentials).not.toHaveBeenCalled()
    expect(existsSync(fixture.markerPath)).toBe(false)
  })
})

function createFixture() {
  const sharedPath = join(root, 'shared-credentials.json')
  const metadataDir = join(root, 'metadata')
  const markerPath = join(metadataDir, LEGACY_SHARED_CLAUDE_AUTH_MIGRATION_MARKER)
  const shared = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fake-access',
      expiresAt: 1,
      refreshToken: 'fake-refresh',
      scopes: ['user:inference']
    }
  })
  writeFileSync(sharedPath, shared, 'utf-8')
  const account: ClaudeManagedAccount = {
    id: 'account-1',
    email: 'user@example.com',
    managedAuthPath: join(root, 'account-1', 'auth'),
    managedAuthRuntime: 'host',
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  const migrate = (overrides: Partial<Parameters<typeof migrateLegacySharedClaudeAuth>[0]>) =>
    migrateLegacySharedClaudeAuth({
      accounts: [account],
      activeAccountId: account.id,
      sharedAuthPath: sharedPath,
      metadataDir,
      readManagedCredentials: async () => null,
      writeManagedCredentials: async () => {},
      ...overrides
    })
  return {
    account,
    shared,
    markerPath,
    marker: () => JSON.parse(readFileSync(markerPath, 'utf-8')) as Record<string, unknown>,
    migrate
  }
}
