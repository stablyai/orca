import type { GlobalSettings } from '../../shared/global-settings-types'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { resolveAntigravityChatAuthConfig } from '../../shared/antigravity-chat-auth-config'
import { resolveAcpLaunchInvocation } from '../acp/acp-structured-launch-resolution'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../acp/acp-launch-specs'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  ANTIGRAVITY_LAUNCH_GATE,
  antigravityChatAccount,
  antigravityChatSignIn
} from './antigravity-chat-account'
import * as browser from './antigravity-browser-helper'
import {
  applyAntigravityChatAuthConfig,
  readAntigravityChatAuthConfig
} from './antigravity-chat-auth-settings'

const enterprise = {
  method: 'oauth-business',
  gcpProject: 'enterprise-project',
  gcpLocation: 'us-central1'
} as const
const folders: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  antigravityChatSignIn.set({ auth: 'unknown', flow: null })
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

it('projects the captured Enterprise choice into the actual launch home, replacing server state without touching tokens', async () => {
  vi.spyOn(browser, 'antigravityBrowserHelperWorks').mockResolvedValue(true)
  const home = await mkdtemp(join(tmpdir(), 'orca-agy-auth-config-'))
  folders.push(home)
  const source: { antigravityChatAuth: NonNullable<GlobalSettings['antigravityChatAuth']> } = {
    antigravityChatAuth: { ...enterprise }
  }
  const launch = await resolveAcpLaunchInvocation(
    ANTIGRAVITY_LAUNCH_SPEC,
    { variable: 'GEMINI_HOME', path: home },
    {
      resolveEnvironment: async () => ({ PATH: '' }),
      resolveCommandSettings: () => source,
      dataDirectory: home
    }
  )
  source.antigravityChatAuth.gcpProject = 'changed-after-capture'
  await antigravityChatAccount.prepare(launch.env, launch.antigravityChatAuth)
  const path = join(home, 'antigravity-acp', 'settings.json')
  const token = join(home, 'antigravity-acp', 'acp_token.json')
  await writeFile(token, 'previous-personal-credential')
  await writeFile(path, JSON.stringify({ auth: { type: 'oauth-personal' } }))
  await antigravityChatAccount.prepare(launch.env, launch.antigravityChatAuth)
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    auth: { type: 'oauth-business' },
    gcp: { project: 'enterprise-project', location: 'us-central1' }
  })
  expect(await readFile(token, 'utf8')).toBe('previous-personal-credential')
})

it('commits only after stopping old writers and retires account observations only after durability', async () => {
  let settings = getDefaultSettings('/fixture')
  const committed = Promise.withResolvers<void>()
  const stopped = vi.fn(async () => {})
  const expired = vi.spyOn(agentModelCatalogStore, 'expireAgent').mockImplementation(() => {})
  antigravityChatSignIn.set({ auth: 'signedIn', flow: null })
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates),
    updateSettingsAndFlush: vi.fn(async (updates: Partial<GlobalSettings>) => {
      expect(stopped).toHaveBeenCalledOnce()
      settings = { ...settings, ...updates }
      await committed.promise
      return settings
    })
  }
  const pending = applyAntigravityChatAuthConfig(store, enterprise, stopped)
  await vi.waitFor(() => expect(store.updateSettingsAndFlush).toHaveBeenCalledOnce())
  expect(() => readAntigravityChatAuthConfig(store)).toThrow('account settings are being saved')
  expect(() => ANTIGRAVITY_LAUNCH_GATE.enter(undefined)).toThrow('setup is changing')
  expect(antigravityChatSignIn.get().value.auth).toBe('signedIn')
  expect(expired).not.toHaveBeenCalled()
  committed.resolve()
  await expect(pending).resolves.toEqual(enterprise)
  expect(antigravityChatSignIn.get().value).toEqual({ auth: 'unknown', flow: null })
  expect(expired).toHaveBeenCalledWith('antigravity')
  stopped.mockClear()
  await applyAntigravityChatAuthConfig(store, enterprise, stopped)
  expect(stopped).not.toHaveBeenCalled()
})

it('keeps the saved choice and account observations when saving or stopping fails', async () => {
  const settings = getDefaultSettings('/fixture')
  const expired = vi.spyOn(agentModelCatalogStore, 'expireAgent').mockImplementation(() => {})
  antigravityChatSignIn.set({ auth: 'signedIn', flow: null })
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates),
    updateSettingsAndFlush: vi.fn(async () => {
      throw new Error('disk full')
    })
  }
  await expect(applyAntigravityChatAuthConfig(store, enterprise, async () => {})).rejects.toThrow(
    'disk full'
  )
  expect(settings.antigravityChatAuth).toBeUndefined()
  expect(readAntigravityChatAuthConfig(store)).toEqual({ method: 'oauth-personal' })
  expect(antigravityChatSignIn.get().value.auth).toBe('signedIn')
  expect(expired).not.toHaveBeenCalled()
  store.updateSettingsAndFlush.mockClear()
  await expect(
    applyAntigravityChatAuthConfig(store, enterprise, async () => {
      throw new Error('writer still live')
    })
  ).rejects.toThrow('writer still live')
  expect(store.updateSettingsAndFlush).not.toHaveBeenCalled()
})

it('rejects incomplete and unknown configured methods rather than selecting personal', () => {
  expect(() =>
    resolveAntigravityChatAuthConfig({ method: 'oauth-business', gcpProject: 'project' })
  ).toThrow('Google Cloud project and location')
  expect(() => resolveAntigravityChatAuthConfig({ method: 'future-method' })).toThrow(
    'account settings'
  )
})

it('repairs a persisted null to Personal instead of accepting a false no-op', async () => {
  const settings = { ...getDefaultSettings('/fixture'), antigravityChatAuth: null }
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates),
    updateSettingsAndFlush: vi.fn(async (updates: Partial<GlobalSettings>) => {
      Object.assign(settings, updates)
      return getDefaultSettings('/fixture')
    })
  }
  // The file can contain an invalid value even though the in-memory contract is typed.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exercising a malformed persisted file at the runtime boundary.
  const malformed = store as unknown as Parameters<typeof applyAntigravityChatAuthConfig>[0]
  await applyAntigravityChatAuthConfig(malformed, { method: 'oauth-personal' }, async () => {})
  expect(store.updateSettingsAndFlush).toHaveBeenCalledOnce()
  expect(readAntigravityChatAuthConfig(malformed)).toEqual({ method: 'oauth-personal' })
})

it('retains remembered Enterprise project and location while Personal is selected', async () => {
  const settings = { ...getDefaultSettings('/fixture'), antigravityChatAuth: enterprise }
  const store = {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>) => Object.assign(settings, updates),
    updateSettingsAndFlush: async (updates: Partial<GlobalSettings>) => {
      Object.assign(settings, updates)
      return settings
    }
  }
  await applyAntigravityChatAuthConfig(
    store,
    { method: 'oauth-personal', gcpProject: 'enterprise-project', gcpLocation: 'us-central1' },
    async () => {}
  )
  expect(readAntigravityChatAuthConfig(store)).toEqual({
    method: 'oauth-personal',
    gcpProject: 'enterprise-project',
    gcpLocation: 'us-central1'
  })
})

it('keeps committed account settings readable while sign-in holds the launch gate', async () => {
  const store = { getSettings: () => getDefaultSettings('/fixture') }
  await ANTIGRAVITY_LAUNCH_GATE.run(
    async () => {},
    async () => {
      antigravityChatSignIn.set({
        auth: 'unknown',
        flow: { flowId: 'signing-in', owner: 'fixture-client', phase: 'waiting' }
      })
      expect(readAntigravityChatAuthConfig(store)).toEqual({ method: 'oauth-personal' })
    }
  )
})
