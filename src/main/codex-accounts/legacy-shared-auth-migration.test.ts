import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexManagedAccount } from '../../shared/types'
import type * as CodexAccountFs from './fs-utils'

const writeFailure = vi.hoisted(() => ({ failNextAuthWrite: false }))

vi.mock('./fs-utils', async () => {
  const actual = await vi.importActual<typeof CodexAccountFs>('./fs-utils')
  return {
    ...actual,
    writeFileAtomically: (targetPath: string, contents: string, options?: { mode?: number }) => {
      if (writeFailure.failNextAuthWrite && targetPath.endsWith('auth.json')) {
        writeFailure.failNextAuthWrite = false
        throw new Error('injected auth write failure')
      }
      actual.writeFileAtomically(targetPath, contents, options)
    }
  }
})

import {
  LEGACY_SHARED_AUTH_MIGRATION_MARKER,
  LEGACY_SHARED_MCP_CREDENTIALS_MIGRATION_MARKER,
  migrateLegacySharedAuthToPerAccountHome
} from './legacy-shared-auth-migration'

type Fixture = ReturnType<typeof createFixture>

let fixture: Fixture

beforeEach(() => {
  fixture = createFixture()
  writeFailure.failNextAuthWrite = false
})

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true })
})

describe('legacy shared Codex auth migration', () => {
  it('atomically migrates a newer unique credential once with 0600 permissions', () => {
    const stale = createAuth('one@example.com', 'acct-1', 'stale', 1_000)
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', stale)
    fixture.writeSharedAuth(fresh)

    fixture.migrate([account], account.id)

    const accountAuthPath = join(account.managedHomePath, 'auth.json')
    expect(readFileSync(accountAuthPath, 'utf-8')).toBe(fresh)
    if (process.platform !== 'win32') {
      expect(statSync(accountAuthPath).mode & 0o777).toBe(0o600)
    }
    expect(readFileSync(fixture.systemAuthPath, 'utf-8')).toBe(fixture.systemSentinel)
    expect(fixture.marker()).toMatchObject({ outcome: 'migrated', accountId: account.id })

    fixture.writeSharedAuth(createAuth('one@example.com', 'acct-1', 'later', 3_000))
    fixture.migrate([account], account.id)
    expect(readFileSync(accountAuthPath, 'utf-8')).toBe(fresh)
  })

  it('marks a uniquely matching stale shared credential as a conclusive no-op', () => {
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const stale = createAuth('one@example.com', 'acct-1', 'stale', 1_000)
    const account = fixture.createAccount('account-1', 'acct-1', fresh)
    fixture.writeSharedAuth(stale)

    fixture.migrate([account], account.id)

    expect(readFileSync(join(account.managedHomePath, 'auth.json'), 'utf-8')).toBe(fresh)
    expect(fixture.marker()).toMatchObject({ outcome: 'not-newer', accountId: account.id })
  })

  it('leaves a mismatched shared identity unadopted and unmarked', () => {
    const managed = createAuth('one@example.com', 'acct-1', 'managed', 1_000)
    const mismatch = createAuth('other@example.com', 'acct-other', 'other', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', managed)
    fixture.writeSharedAuth(mismatch)

    fixture.migrate([account], account.id)

    expect(readFileSync(join(account.managedHomePath, 'auth.json'), 'utf-8')).toBe(managed)
    expect(existsSync(fixture.markerPath)).toBe(false)
  })

  it('leaves duplicate-identity accounts ambiguous and unmarked', () => {
    const account1 = fixture.createAccount(
      'account-1',
      'acct-duplicate',
      createAuth('same@example.com', 'acct-duplicate', 'one', 1_000)
    )
    const account2 = fixture.createAccount(
      'account-2',
      'acct-duplicate',
      createAuth('same@example.com', 'acct-duplicate', 'two', 1_000)
    )
    fixture.writeSharedAuth(createAuth('same@example.com', 'acct-duplicate', 'shared', 2_000))

    fixture.migrate([account1, account2], account1.id)

    expect(readFileSync(join(account1.managedHomePath, 'auth.json'), 'utf-8')).toContain('one')
    expect(readFileSync(join(account2.managedHomePath, 'auth.json'), 'utf-8')).toContain('two')
    expect(existsSync(fixture.markerPath)).toBe(false)
  })

  it('refuses an untrusted account home without reading or mutating real ~/.codex', () => {
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', fresh)
    account.managedHomePath = fixture.systemHome
    fixture.writeSharedAuth(fresh)

    fixture.migrate([account], account.id)

    expect(readFileSync(fixture.systemAuthPath, 'utf-8')).toBe(fixture.systemSentinel)
    expect(existsSync(fixture.markerPath)).toBe(false)
    expect(existsSync(fixture.mcpMarkerPath)).toBe(false)
  })

  it('migrates the active account even when another account home is stale or deleted', () => {
    const stale = createAuth('one@example.com', 'acct-1', 'stale', 1_000)
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', stale)
    const broken = fixture.createAccount(
      'account-2',
      'acct-2',
      createAuth('one@example.com', 'acct-2', 'other', 1_000)
    )
    rmSync(broken.managedHomePath, { recursive: true, force: true })
    fixture.writeSharedAuth(fresh)

    fixture.migrate([account, broken], account.id)

    expect(readFileSync(join(account.managedHomePath, 'auth.json'), 'utf-8')).toBe(fresh)
    expect(fixture.marker()).toMatchObject({ outcome: 'migrated', accountId: account.id })
  })

  it('keeps a deleted-home duplicate identity in the ambiguity gate', () => {
    const account1 = fixture.createAccount(
      'account-1',
      'acct-duplicate',
      createAuth('same@example.com', 'acct-duplicate', 'one', 1_000)
    )
    const account2 = fixture.createAccount(
      'account-2',
      'acct-duplicate',
      createAuth('same@example.com', 'acct-duplicate', 'two', 1_000)
    )
    rmSync(account2.managedHomePath, { recursive: true, force: true })
    fixture.writeSharedAuth(createAuth('same@example.com', 'acct-duplicate', 'shared', 2_000))

    fixture.migrate([account1, account2], account1.id)

    expect(readFileSync(join(account1.managedHomePath, 'auth.json'), 'utf-8')).toContain('one')
    expect(existsSync(fixture.markerPath)).toBe(false)
    expect(existsSync(fixture.mcpMarkerPath)).toBe(false)
  })

  it('leaves a failed atomic write unmarked and succeeds on the next startup retry', () => {
    const stale = createAuth('one@example.com', 'acct-1', 'stale', 1_000)
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', stale)
    fixture.writeSharedAuth(fresh)
    writeFailure.failNextAuthWrite = true

    expect(() => fixture.migrate([account], account.id)).toThrow('injected auth write failure')
    expect(readFileSync(join(account.managedHomePath, 'auth.json'), 'utf-8')).toBe(stale)
    expect(existsSync(fixture.markerPath)).toBe(false)

    fixture.migrate([account], account.id)
    expect(readFileSync(join(account.managedHomePath, 'auth.json'), 'utf-8')).toBe(fresh)
    expect(fixture.marker()).toMatchObject({ outcome: 'migrated' })
  })
})

describe('legacy shared Codex MCP credentials migration (#8440)', () => {
  it('carries the shared MCP .credentials.json into the identity-proven home with 0600 perms', () => {
    const stale = createAuth('one@example.com', 'acct-1', 'stale', 1_000)
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', stale)
    fixture.writeSharedAuth(fresh)
    const mcpStore = JSON.stringify({ MCP_OAUTH: { 'server-a': { access_token: 'tok-a' } } })
    fixture.writeSharedCredentials(mcpStore)

    fixture.migrate([account], account.id)

    const credentialsPath = fixture.accountCredentialsPath(account)
    expect(readFileSync(credentialsPath, 'utf-8')).toBe(mcpStore)
    if (process.platform !== 'win32') {
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600)
    }
    expect(fixture.marker()).toMatchObject({ outcome: 'migrated', accountId: account.id })
  })

  it('carries the shared MCP store even when auth.json is already current', () => {
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', fresh)
    fixture.writeSharedAuth(fresh)
    const mcpStore = JSON.stringify({ MCP_OAUTH: { 'server-a': { access_token: 'tok-a' } } })
    fixture.writeSharedCredentials(mcpStore)

    fixture.migrate([account], account.id)

    expect(readFileSync(fixture.accountCredentialsPath(account), 'utf-8')).toBe(mcpStore)
    expect(fixture.marker()).toMatchObject({ outcome: 'already-current' })
  })

  it('is a no-op when the shared mirror has no MCP .credentials.json', () => {
    const stale = createAuth('one@example.com', 'acct-1', 'stale', 1_000)
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', stale)
    fixture.writeSharedAuth(fresh)

    fixture.migrate([account], account.id)

    expect(existsSync(fixture.accountCredentialsPath(account))).toBe(false)
    expect(fixture.marker()).toMatchObject({ outcome: 'migrated' })
  })

  it('never clobbers a newer per-account .credentials.json', () => {
    const stale = createAuth('one@example.com', 'acct-1', 'stale', 1_000)
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', stale)
    fixture.writeSharedAuth(fresh)
    fixture.writeSharedCredentials(
      JSON.stringify({ MCP_OAUTH: { 'server-a': { access_token: 'shared-stale' } } })
    )
    const perAccountStore = JSON.stringify({
      MCP_OAUTH: { 'server-a': { access_token: 'per-account-fresh' } }
    })
    writeFileSync(fixture.accountCredentialsPath(account), perAccountStore, 'utf-8')

    fixture.migrate([account], account.id)

    expect(readFileSync(fixture.accountCredentialsPath(account), 'utf-8')).toBe(perAccountStore)
  })

  it('carries the MCP store even when an auth-only build already stamped the v1 auth marker', () => {
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', fresh)
    fixture.writeSharedAuth(fresh)
    const mcpStore = JSON.stringify({ MCP_OAUTH: { 'server-a': { access_token: 'tok-a' } } })
    fixture.writeSharedCredentials(mcpStore)
    writeFileSync(
      fixture.markerPath,
      `${JSON.stringify({ completedAt: 1, outcome: 'already-current', accountId: account.id })}\n`,
      'utf-8'
    )

    fixture.migrate([account], account.id)

    expect(readFileSync(fixture.accountCredentialsPath(account), 'utf-8')).toBe(mcpStore)
    expect(fixture.mcpMarker()).toMatchObject({ outcome: 'migrated', accountId: account.id })
  })

  it('is a full no-op once both generation markers are present', () => {
    const stale = createAuth('one@example.com', 'acct-1', 'stale', 1_000)
    const fresh = createAuth('one@example.com', 'acct-1', 'fresh', 2_000)
    const account = fixture.createAccount('account-1', 'acct-1', stale)
    fixture.writeSharedAuth(fresh)
    fixture.writeSharedCredentials(
      JSON.stringify({ MCP_OAUTH: { 'server-a': { access_token: 'tok-a' } } })
    )
    const stamp = `${JSON.stringify({ completedAt: 1, outcome: 'migrated', accountId: account.id })}\n`
    writeFileSync(fixture.markerPath, stamp, 'utf-8')
    writeFileSync(fixture.mcpMarkerPath, stamp, 'utf-8')

    fixture.migrate([account], account.id)

    expect(readFileSync(join(account.managedHomePath, 'auth.json'), 'utf-8')).toBe(stale)
    expect(existsSync(fixture.accountCredentialsPath(account))).toBe(false)
  })

  it('stamps both generation markers when the mirror has no auth.json', () => {
    const account = fixture.createAccount(
      'account-1',
      'acct-1',
      createAuth('one@example.com', 'acct-1', 'managed', 1_000)
    )

    fixture.migrate([account], account.id)

    expect(fixture.marker()).toMatchObject({ outcome: 'no-shared-auth' })
    expect(fixture.mcpMarker()).toMatchObject({ outcome: 'no-shared-auth' })
  })

  it('never leaks the shared MCP store to a non-matching account', () => {
    const account1 = fixture.createAccount(
      'account-1',
      'acct-duplicate',
      createAuth('same@example.com', 'acct-duplicate', 'one', 1_000)
    )
    const account2 = fixture.createAccount(
      'account-2',
      'acct-duplicate',
      createAuth('same@example.com', 'acct-duplicate', 'two', 1_000)
    )
    fixture.writeSharedAuth(createAuth('same@example.com', 'acct-duplicate', 'shared', 2_000))
    fixture.writeSharedCredentials(
      JSON.stringify({ MCP_OAUTH: { 'server-a': { access_token: 'tok-a' } } })
    )

    // Ambiguous identity: neither account is a unique match, so nothing is carried.
    fixture.migrate([account1, account2], account1.id)

    expect(existsSync(fixture.accountCredentialsPath(account1))).toBe(false)
    expect(existsSync(fixture.accountCredentialsPath(account2))).toBe(false)
    expect(existsSync(fixture.markerPath)).toBe(false)
  })
})

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-auth-migration-'))
  const managedAccountsRoot = join(root, 'codex-accounts')
  const metadataDir = join(root, 'codex-runtime-home')
  const sharedRuntimeHome = join(metadataDir, 'home')
  const systemHome = join(root, 'home', '.codex')
  const systemAuthPath = join(systemHome, 'auth.json')
  const systemSentinel = 'system auth must remain untouched\n'
  mkdirSync(sharedRuntimeHome, { recursive: true })
  mkdirSync(systemHome, { recursive: true })
  writeFileSync(systemAuthPath, systemSentinel, 'utf-8')
  chmodSync(systemAuthPath, 0o600)
  const markerPath = join(metadataDir, LEGACY_SHARED_AUTH_MIGRATION_MARKER)
  const mcpMarkerPath = join(metadataDir, LEGACY_SHARED_MCP_CREDENTIALS_MIGRATION_MARKER)

  return {
    root,
    managedAccountsRoot,
    metadataDir,
    sharedRuntimeHome,
    systemHome,
    systemAuthPath,
    systemSentinel,
    markerPath,
    mcpMarkerPath,
    createAccount(accountId: string, providerAccountId: string, auth: string) {
      const managedHomePath = join(managedAccountsRoot, accountId, 'home')
      mkdirSync(managedHomePath, { recursive: true })
      writeFileSync(join(managedHomePath, '.orca-managed-home'), `${accountId}\n`, 'utf-8')
      writeFileSync(join(managedHomePath, 'auth.json'), auth, 'utf-8')
      return createAccount(accountId, providerAccountId, managedHomePath)
    },
    writeSharedAuth(auth: string) {
      writeFileSync(join(sharedRuntimeHome, 'auth.json'), auth, 'utf-8')
    },
    writeSharedCredentials(credentials: string) {
      writeFileSync(join(sharedRuntimeHome, '.credentials.json'), credentials, 'utf-8')
    },
    accountCredentialsPath(account: CodexManagedAccount) {
      return join(account.managedHomePath, '.credentials.json')
    },
    migrate(hostAccounts: readonly CodexManagedAccount[], activeHostAccountId: string | null) {
      migrateLegacySharedAuthToPerAccountHome({
        activeHostAccountId,
        hostAccounts,
        managedAccountsRoot,
        metadataDir,
        sharedRuntimeHome,
        systemCodexHome: systemHome
      })
    },
    marker(): { outcome: string; accountId?: string } {
      return JSON.parse(readFileSync(markerPath, 'utf-8')) as {
        outcome: string
        accountId?: string
      }
    },
    mcpMarker(): { outcome: string; accountId?: string } {
      return JSON.parse(readFileSync(mcpMarkerPath, 'utf-8')) as {
        outcome: string
        accountId?: string
      }
    }
  }
}

function createAccount(
  id: string,
  providerAccountId: string,
  managedHomePath: string
): CodexManagedAccount {
  return {
    id,
    email: providerAccountId === 'acct-duplicate' ? 'same@example.com' : 'one@example.com',
    managedHomePath,
    providerAccountId,
    workspaceLabel: null,
    workspaceAccountId: providerAccountId,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function createAuth(
  email: string,
  accountId: string,
  refreshToken: string,
  expiresAt: number
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      email,
      exp: expiresAt,
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
        workspace_account_id: accountId
      }
    })
  ).toString('base64url')
  return `${JSON.stringify({
    tokens: {
      id_token: `${header}.${payload}.`,
      account_id: accountId,
      refresh_token: refreshToken,
      expires_at: expiresAt
    }
  })}\n`
}
