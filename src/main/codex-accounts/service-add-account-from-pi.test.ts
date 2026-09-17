import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

const { getPiCodexCredentialMock } = vi.hoisted(() => ({
  getPiCodexCredentialMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

vi.mock('./pi-codex-auth', async () => {
  const actual = await vi.importActual<typeof import('./pi-codex-auth')>('./pi-codex-auth') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, getPiCodexCredential: getPiCodexCredentialMock }
})

import { CodexAccountService } from './service'
import { PI_CODEX_AUTH_SOURCE_FILENAME } from './pi-codex-auth'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

describe('CodexAccountService.addAccountFromPi', () => {
  registerCodexAccountsTestHomes()

  it('registers a Pi-linked account without starting Codex login', async () => {
    const credential = {
      accessToken: jwt({
        email: 'pi@example.com',
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        'https://api.openai.com/auth': { chatgpt_account_id: 'pi-account' }
      }),
      providerAccountId: 'pi-account',
      email: 'pi@example.com'
    }
    getPiCodexCredentialMock.mockResolvedValue(credential)
    const settings = createSettings()
    const store = createStore(settings)
    const runtimeHome = createRuntimeHome()
    const service = new CodexAccountService(
      store as never,
      createRateLimits() as never,
      runtimeHome as never
    )

    const result = await service.addAccountFromPi()

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      email: 'pi@example.com',
      providerAccountId: 'pi-account',
      credentialSource: 'pi'
    })
    const managedHome = store.getSettings().codexManagedAccounts[0]!.managedHomePath
    expect(existsSync(`${managedHome}/auth.json`)).toBe(true)
    expect(
      JSON.parse(readFileSync(`${managedHome}/${PI_CODEX_AUTH_SOURCE_FILENAME}`, 'utf8'))
    ).toEqual({ providerAccountId: 'pi-account' })
    expect(runtimeHome.syncForCurrentSelection).toHaveBeenCalled()
  })

  it('rejects a duplicate provider account before creating another home', async () => {
    getPiCodexCredentialMock.mockResolvedValue({
      accessToken: 'unused',
      providerAccountId: 'existing-provider-account',
      email: 'pi@example.com'
    })
    const settings = createSettings()
    settings.codexManagedAccounts.push({
      id: 'existing',
      email: 'pi@example.com',
      managedHomePath: `${testState.userDataDir}/codex-accounts/existing/home`,
      managedHomeRuntime: 'host',
      providerAccountId: 'existing-provider-account',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })
    const store = createStore(settings)
    const service = new CodexAccountService(
      store as never,
      createRateLimits() as never,
      createRuntimeHome() as never
    )

    await expect(service.addAccountFromPi()).rejects.toThrow(/already imported/)
    expect(store.getSettings().codexManagedAccounts).toHaveLength(1)
  })
})
