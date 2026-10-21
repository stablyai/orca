/* oxlint-disable anti-slop/no-module-mocking -- Vitest support module for the runtime-home specs, not shipped code, and it falls outside the *.test / *.spec / tests glob set.
   setupRuntimeHomeTest() stubs the Windows registry so the PowerShell profile probe reads only the fake
   home; inlining that stub into every spec that routes a launch would duplicate it many times. */
import { expect, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { CodexManagedAccount } from '../../shared/managed-account-types'

export const testState: {
  userDataDir: string
  fakeHomeDir: string
  previousUserDataPath?: string
  previousCodexHome?: string
} = { userDataDir: '', fakeHomeDir: '' }

// Why: a custom CODEX_HOME is the production route onto the mirror lane.
export function setRealHomeRoutableForTest(enabled: boolean): void {
  if (enabled) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = join(tmpdir(), 'orca-test-custom-codex-home')
  }
}

export function getSystemCodexHomePath(): string {
  return join(testState.fakeHomeDir, '.codex')
}

export function getSystemCodexAuthPath(): string {
  return join(getSystemCodexHomePath(), 'auth.json')
}

export function getRuntimeCodexHomePath(): string {
  return join(testState.userDataDir, 'codex-runtime-home', 'home')
}

export function getRuntimeCodexAuthPath(): string {
  return join(getRuntimeCodexHomePath(), 'auth.json')
}

export function getSharedRuntimeAuthProvenancePath(): string {
  return join(testState.userDataDir, 'codex-runtime-home', 'shared-runtime-auth-provenance.json')
}

export function writePaneRegistry(
  panes: Record<string, { selectionKey: string; accountId: string | null; homeRoute?: string }>
): void {
  writeFileSync(
    join(testState.userDataDir, 'codex-pane-accounts.json'),
    `${JSON.stringify({ version: 2, panes })}\n`,
    'utf-8'
  )
}

export function getLegacyActiveHostCodexHomePath(): string {
  return join(testState.userDataDir, 'codex-runtime-home', 'active', 'host', 'home')
}

export function normalizeLinkTarget(linkTarget: string): string {
  return process.platform === 'win32'
    ? linkTarget.replace(/^\\\\\?\\/, '').toLowerCase()
    : linkTarget
}

export function expectResourceLinkedOrCopied(targetPath: string, sourcePath: string): void {
  expect(existsSync(targetPath)).toBe(true)
  if (!lstatSync(targetPath).isSymbolicLink()) {
    return
  }
  expect(normalizeLinkTarget(readlinkSync(targetPath))).toBe(normalizeLinkTarget(sourcePath))
}

export function createStore(settings: GlobalSettings) {
  return {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = {
        ...settings,
        ...updates,
        notifications: {
          ...settings.notifications,
          ...updates.notifications
        }
      }
      return settings
    })
  }
}

export function createManagedAuth(rootDir: string, accountId: string, auth: string): string {
  const managedHomePath = join(rootDir, 'codex-accounts', accountId, 'home')
  mkdirSync(managedHomePath, { recursive: true })
  writeFileSync(join(managedHomePath, '.orca-managed-home'), `${accountId}\n`, 'utf-8')
  writeFileSync(join(managedHomePath, 'auth.json'), auth, 'utf-8')
  return managedHomePath
}

export function createCodexAccountRecord(
  id: string,
  email: string,
  providerAccountId: string,
  managedHomePath: string
): CodexManagedAccount {
  return {
    id,
    email,
    managedHomePath,
    providerAccountId,
    workspaceLabel: null,
    workspaceAccountId: providerAccountId,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

export function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function createCodexAuthJson(
  email: string,
  accountId: string,
  refreshToken: string,
  expiresAt?: number,
  lastRefresh?: string
): string {
  const idToken = [
    encodeJwtPart({ alg: 'none', typ: 'JWT' }),
    encodeJwtPart({
      email,
      ...(expiresAt === undefined ? {} : { exp: expiresAt }),
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
        workspace_account_id: accountId
      }
    }),
    ''
  ].join('.')

  return `${JSON.stringify({
    auth_mode: 'chatgpt',
    ...(lastRefresh === undefined ? {} : { last_refresh: lastRefresh }),
    tokens: {
      access_token: `access-${accountId}`,
      id_token: idToken,
      account_id: accountId,
      ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
      refresh_token: refreshToken
    }
  })}\n`
}

/** Mirrors the suite's shared beforeEach: fresh userData/home temp dirs plus the pane registry. */
export function setupRuntimeHomeTest(): void {
  vi.resetModules()
  vi.clearAllMocks()
  testState.previousCodexHome = process.env.CODEX_HOME
  setRealHomeRoutableForTest(true)
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-runtime-home-'))
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
  // Why: Windows routing reads PowerShell profiles and Git Bash rc files; keep
  // them, and the registry-named Documents folder, inside the fake home.
  vi.doMock('../windows-native-registry', () => ({
    loadWindowsNativeRegistry: () => {
      throw new Error('no registry in runtime-home tests')
    }
  }))
  vi.stubEnv('USERPROFILE', testState.fakeHomeDir)
  vi.stubEnv('SystemRoot', join(testState.fakeHomeDir, 'Windows'))
  vi.stubEnv('ProgramFiles', join(testState.fakeHomeDir, 'Program Files'))
  testState.previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = testState.userDataDir
  mkdirSync(getSystemCodexHomePath(), { recursive: true })
  mkdirSync(getRuntimeCodexHomePath(), { recursive: true })
  writePaneRegistry({
    'retained-shared-pane': {
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home'
    }
  })
}

export function teardownRuntimeHomeTest(): void {
  vi.unstubAllEnvs()
  rmSync(testState.userDataDir, { recursive: true, force: true })
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  if (testState.previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = testState.previousUserDataPath
  }
  if (testState.previousCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = testState.previousCodexHome
  }
}
