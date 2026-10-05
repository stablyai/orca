import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createClaudeCredentialsJson,
  createElectronMock,
  createKeychainMock,
  createManagedClaudeAuth,
  createOauthRefreshMock,
  createSettings,
  createStore,
  readManagedCredentialsForTest,
  resetRuntimeAuthTestState,
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./keychain', () => createKeychainMock())
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

const sharedFields = {
  mcpOAuth: { figma: { accessToken: 'mcp-access', refreshToken: 'mcp-refresh' } },
  mcpOAuthClientConfig: { figma: { clientId: 'figma-client' } },
  mcpXaaIdp: { token: 'idp-token' },
  mcpXaaIdpConfig: { issuer: 'idp-issuer' },
  pluginSecrets: { plugin: 'secret' }
}

function withSharedFields(credentials: string, fields = sharedFields): string {
  return JSON.stringify({ ...JSON.parse(credentials), ...fields })
}

async function setup(platform: NodeJS.Platform = 'darwin') {
  setPlatform(platform)
  const runtimePath = join(testState.fakeHomeDir, '.claude', '.credentials.json')
  const system = createClaudeCredentialsJson('system@example.com', 'system')
  const first = createClaudeCredentialsJson('first@example.com', 'first')
  const second = createClaudeCredentialsJson('second@example.com', 'second')
  const firstPath = createManagedClaudeAuth(testState.userDataDir, 'first', first)
  const secondPath = createManagedClaudeAuth(testState.userDataDir, 'second', second)
  writeFileSync(runtimePath, withSharedFields(system))
  testState.scopedKeychainCredentials = withSharedFields(system)
  testState.legacyKeychainCredentials = withSharedFields(system)
  const settings = createSettings({
    claudeManagedAccounts: [
      createClaudeAccount('first', firstPath, { email: 'first@example.com' }),
      createClaudeAccount('second', secondPath, { email: 'second@example.com' })
    ]
  })
  const store = createStore(settings)
  const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime auth uses only getSettings/updateSettings from this store mock.
  const service = new ClaudeRuntimeAuthService(store as never)
  await service.syncForCurrentSelection()
  return { service, settings, runtimePath, first, second, system, firstPath, secondPath }
}

describe('shared Claude connector credentials', () => {
  beforeEach(resetRuntimeAuthTestState)
  afterEach(cleanupRuntimeAuthTestState)

  it.each(['darwin', 'linux', 'win32'] as const)(
    'excludes connector secrets when capturing a managed account on %s',
    async (platform) => {
      const { firstPath, first } = await setup(platform)
      const { ClaudeManagedAuthStorage } = await import('./claude-managed-auth-storage')
      await new ClaudeManagedAuthStorage().writeCredentials(
        'first',
        firstPath,
        withSharedFields(first)
      )
      expect(JSON.parse(readManagedCredentialsForTest('first', firstPath) ?? '')).toEqual(
        JSON.parse(first)
      )
    }
  )

  it.each(['scoped', 'legacy', 'file'] as const)(
    'propagates connector revocations from the %s surface and does not resurrect frozen account grants',
    async (surface) => {
      const { service, settings, runtimePath, first, secondPath, second } = await setup()
      settings.activeClaudeManagedAccountId = 'first'
      await service.syncForCurrentSelection()
      if (surface === 'scoped') {
        testState.scopedKeychainCredentials = first
      } else if (surface === 'legacy') {
        testState.legacyKeychainCredentials = first
      } else {
        writeFileSync(runtimePath, first)
      }
      testState.managedKeychainCredentials.set('second', withSharedFields(second))
      writeFileSync(join(secondPath, '.credentials.json'), withSharedFields(second))
      settings.activeClaudeManagedAccountId = 'second'
      await service.syncForCurrentSelection()
      expect(JSON.parse(readFileSync(runtimePath, 'utf-8'))).toEqual(JSON.parse(second))
      expect(JSON.parse(testState.scopedKeychainCredentials ?? '')).toEqual(JSON.parse(second))
      expect(JSON.parse(testState.legacyKeychainCredentials ?? '')).toEqual(JSON.parse(second))
    }
  )

  it('preserves grants refreshed only in the keychain when returning to the system default', async () => {
    const { service, settings, runtimePath, first } = await setup()
    settings.activeClaudeManagedAccountId = 'first'
    await service.syncForCurrentSelection()
    const rotated = {
      ...sharedFields,
      mcpOAuth: { figma: { accessToken: 'rotated', refreshToken: 'rotated' } }
    }
    testState.legacyKeychainCredentials = withSharedFields(first, rotated)
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()
    expect(JSON.parse(readFileSync(runtimePath, 'utf-8'))).toMatchObject(rotated)
    expect(JSON.parse(testState.scopedKeychainCredentials ?? '')).toMatchObject(rotated)
    expect(JSON.parse(testState.legacyKeychainCredentials ?? '')).toMatchObject(rotated)
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    'keeps connector grants through account switches, syncs, restart, and deselect on %s',
    async (platform) => {
      const state = await setup(platform)
      const { service, settings, runtimePath, first, second, firstPath, secondPath } = state
      for (const id of ['first', 'second', 'first']) {
        settings.activeClaudeManagedAccountId = id
        await service.syncForCurrentSelection()
        await service.syncForCurrentSelection()
        const runtime = JSON.parse(readFileSync(runtimePath, 'utf-8'))
        expect(runtime).toMatchObject(sharedFields)
        expect(runtime.claudeAiOauth.accessToken).toBe(id)
        if (platform === 'darwin') {
          expect(testState.scopedKeychainCredentials).toBe(readFileSync(runtimePath, 'utf-8'))
          expect(testState.legacyKeychainCredentials).toBe(testState.scopedKeychainCredentials)
        }
      }
      expect(JSON.parse(readManagedCredentialsForTest('first', firstPath) ?? '')).toEqual(
        JSON.parse(first)
      )
      expect(JSON.parse(readManagedCredentialsForTest('second', secondPath) ?? '')).toEqual(
        JSON.parse(second)
      )
      const rotated = {
        ...sharedFields,
        mcpOAuth: { figma: { accessToken: 'rotated-access', refreshToken: 'rotated-refresh' } }
      }
      const live = withSharedFields(first, rotated)
      writeFileSync(runtimePath, live)
      testState.scopedKeychainCredentials = live
      testState.legacyKeychainCredentials = live
      const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime auth uses only getSettings/updateSettings from this store mock.
      const restarted = new ClaudeRuntimeAuthService(createStore(settings) as never)
      await restarted.syncForCurrentSelection()
      settings.activeClaudeManagedAccountId = null
      await restarted.syncForCurrentSelection()
      const restored = JSON.parse(readFileSync(runtimePath, 'utf-8'))
      expect(restored).toMatchObject(rotated)
      expect(restored.claudeAiOauth.accessToken).toBe('system')
      if (platform === 'darwin') {
        expect(JSON.parse(testState.scopedKeychainCredentials ?? '')).toMatchObject(rotated)
        expect(JSON.parse(testState.legacyKeychainCredentials ?? '')).toMatchObject(rotated)
      }
    }
  )

  it.each(['scoped', 'legacy', 'file'] as const)(
    'preserves MCP rotations written only to the %s surface while adopting a Claude refresh',
    async (surface) => {
      const { service, settings, runtimePath, firstPath } = await setup()
      settings.activeClaudeManagedAccountId = 'first'
      await service.syncForCurrentSelection()
      const refreshed = createClaudeCredentialsJson(
        'first@example.com',
        'refreshed',
        null,
        Date.now() + 120_000
      )
      const rotated = {
        ...sharedFields,
        mcpOAuth: { figma: { accessToken: 'new-access', refreshToken: 'new-refresh' } }
      }
      const live = withSharedFields(refreshed, rotated)
      if (surface === 'scoped') {
        testState.scopedKeychainCredentials = live
      }
      if (surface === 'legacy') {
        testState.legacyKeychainCredentials = live
      }
      if (surface === 'file') {
        writeFileSync(runtimePath, live)
      }
      await service.syncForCurrentSelection()
      expect(JSON.parse(readFileSync(runtimePath, 'utf-8'))).toMatchObject(rotated)
      expect(JSON.parse(readManagedCredentialsForTest('first', firstPath) ?? '')).toEqual(
        JSON.parse(refreshed)
      )
    }
  )

  it('leaves all credentials untouched when the active keychain cannot be read', async () => {
    const { service, settings, runtimePath } = await setup()
    settings.activeClaudeManagedAccountId = 'first'
    await service.syncForCurrentSelection()
    const before = readFileSync(runtimePath, 'utf-8')
    settings.activeClaudeManagedAccountId = 'second'
    testState.throwScopedKeychainRead = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(service.syncForCurrentSelection()).rejects.toThrow('scoped keychain read failed')
    expect(readFileSync(runtimePath, 'utf-8')).toBe(before)
    expect(testState.scopedKeychainCredentials).toBe(before)
    expect(testState.legacyKeychainCredentials).toBe(before)
    testState.throwScopedKeychainRead = false
    await service.syncForCurrentSelection()
    expect(JSON.parse(readFileSync(runtimePath, 'utf-8'))).toMatchObject(sharedFields)
    expect(JSON.parse(readFileSync(runtimePath, 'utf-8')).claudeAiOauth.accessToken).toBe('second')
    warn.mockRestore()
  })

  it.each(['scoped', 'legacy', 'file'] as const)(
    'refuses to overwrite malformed live credentials in the %s surface',
    async (surface) => {
      const { service, settings, runtimePath } = await setup()
      settings.activeClaudeManagedAccountId = 'first'
      await service.syncForCurrentSelection()
      if (surface === 'scoped') {
        testState.scopedKeychainCredentials = '{broken'
      } else if (surface === 'legacy') {
        testState.legacyKeychainCredentials = '{broken'
      } else {
        writeFileSync(runtimePath, '{broken')
      }
      const fileBefore = readFileSync(runtimePath, 'utf-8')
      const scopedBefore = testState.scopedKeychainCredentials
      const legacyBefore = testState.legacyKeychainCredentials
      settings.activeClaudeManagedAccountId = 'second'
      await expect(service.syncForCurrentSelection()).rejects.toThrow(
        'Cannot preserve malformed Claude runtime credentials'
      )
      expect(readFileSync(runtimePath, 'utf-8')).toBe(fileBefore)
      expect(testState.scopedKeychainCredentials).toBe(scopedBefore)
      expect(testState.legacyKeychainCredentials).toBe(legacyBefore)
    }
  )

  it('keeps newly authorized MCP grants when returning to a signed-out system default', async () => {
    const { service, settings, runtimePath, first } = await setup()
    // A missing system credential is a signed-out default, with no connector grants yet.
    rmSync(runtimePath)
    testState.scopedKeychainCredentials = null
    testState.legacyKeychainCredentials = null
    settings.activeClaudeManagedAccountId = 'first'
    await service.syncForCurrentSelection()
    const live = withSharedFields(first)
    writeFileSync(runtimePath, live)
    testState.scopedKeychainCredentials = live
    testState.legacyKeychainCredentials = live
    settings.activeClaudeManagedAccountId = null
    await service.syncForCurrentSelection()
    expect(existsSync(runtimePath)).toBe(true)
    expect(JSON.parse(readFileSync(runtimePath, 'utf-8'))).toEqual(sharedFields)
    expect(JSON.parse(testState.scopedKeychainCredentials ?? '')).toEqual(sharedFields)
    expect(JSON.parse(testState.legacyKeychainCredentials ?? '')).toEqual(sharedFields)
  })
})
