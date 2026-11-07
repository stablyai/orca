import type { GlobalSettings } from '../../shared/global-settings-types'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { resolveAcpLaunchInvocation } from '../acp/acp-structured-launch-resolution'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
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
