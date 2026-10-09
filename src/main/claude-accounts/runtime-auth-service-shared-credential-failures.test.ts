import {
  cleanupRuntimeAuthTestState,
  createElectronMock,
  createKeychainMock,
  createOauthRefreshMock,
  resetRuntimeAuthTestState,
  testState
} from './runtime-auth-service-test-harness'
import {
  createSharedCredentialRuntime,
  sharedFields,
  withSharedFields
} from './runtime-auth-shared-credentials-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'

vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./keychain', () => createKeychainMock())
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, homedir: () => testState.fakeHomeDir }
})

describe('shared connector credential write failures', () => {
  beforeEach(resetRuntimeAuthTestState)
  afterEach(cleanupRuntimeAuthTestState)

  it('keeps the committed baseline across a partial rollback so a rotated grant can be retried', async () => {
    const { service, settings, runtimePath, first } = await createSharedCredentialRuntime()
    settings.activeClaudeManagedAccountId = 'first'
    await service.syncForCurrentSelection()
    const rotated = {
      ...sharedFields,
      mcpOAuth: { figma: { accessToken: 'new-access', refreshToken: 'new-refresh' } }
    }
    testState.scopedKeychainCredentials = withSharedFields(first, rotated)
    settings.activeClaudeManagedAccountId = 'second'
    testState.throwLegacyRuntimeKeychainWrite = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow(
      'legacy runtime keychain write failed'
    )
    expect(JSON.parse(readFileSync(runtimePath, 'utf-8'))).toMatchObject(rotated)
    testState.throwLegacyRuntimeKeychainWrite = false
    settings.activeClaudeManagedAccountId = 'first'
    await service.forceMaterializeCurrentSelectionForRollback()
    expect(JSON.parse(readFileSync(runtimePath, 'utf-8'))).toMatchObject(rotated)
    expect(JSON.parse(readFileSync(runtimePath, 'utf-8')).claudeAiOauth.accessToken).toBe('first')
    expect(testState.scopedKeychainCredentials).toBe(readFileSync(runtimePath, 'utf-8'))
    expect(testState.legacyKeychainCredentials).toBe(testState.scopedKeychainCredentials)
  })

  it('preserves disjoint live grants when the first switch fails after writing only the scoped item', async () => {
    const { service, settings, runtimePath, system } = await createSharedCredentialRuntime()
    const figma = sharedFields.mcpOAuth.figma
    testState.scopedKeychainCredentials = withSharedFields(system, {
      ...sharedFields,
      mcpOAuth: { figma }
    })
    testState.legacyKeychainCredentials = withSharedFields(system, {
      ...sharedFields,
      mcpOAuth: { notion: { accessToken: 'notion-access', refreshToken: 'notion-refresh' } }
    })
    writeFileSync(runtimePath, system)
    settings.activeClaudeManagedAccountId = 'first'
    testState.throwLegacyRuntimeKeychainWrite = true
    await expect(service.syncForCurrentSelection()).rejects.toThrow(
      'legacy runtime keychain write failed'
    )
    expect(JSON.parse(readFileSync(runtimePath, 'utf-8')).mcpOAuth).toEqual({
      figma,
      notion: { accessToken: 'notion-access', refreshToken: 'notion-refresh' }
    })
    testState.throwLegacyRuntimeKeychainWrite = false
    await service.syncForCurrentSelection()
    const runtime = JSON.parse(readFileSync(runtimePath, 'utf-8'))
    expect(runtime.mcpOAuth).toEqual({
      figma,
      notion: { accessToken: 'notion-access', refreshToken: 'notion-refresh' }
    })
    expect(runtime.claudeAiOauth.accessToken).toBe('first')
    expect(testState.scopedKeychainCredentials).toBe(readFileSync(runtimePath, 'utf-8'))
    expect(testState.legacyKeychainCredentials).toBe(testState.scopedKeychainCredentials)
  })
})
