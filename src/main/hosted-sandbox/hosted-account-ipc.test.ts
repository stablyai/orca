import { afterEach, expect, it, vi } from 'vitest'

const handlers = new Map<string, () => unknown>()
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler) },
  shell: { openExternal }
}))

import { ORCA_CLOUD_WORKSPACE_CHANNELS as CH } from '../../shared/hosted-sandbox/cloud-workspace-api'
import { registerHostedAccountHandlers } from './hosted-account-ipc'

afterEach(() => {
  handlers.clear()
  vi.clearAllMocks()
})

function register(installUrl: string, config = vi.fn(async () => ({ idleSleepMinutes: 15 }))) {
  registerHostedAccountHandlers({
    config,
    connectGitHub: async () => ({ installUrl, authorizeUrl: installUrl })
  })
  return config
}

it('opens only a github.com page for Connect GitHub', async () => {
  register('https://github.com/apps/orca-cloud-dev/installations/new?state=x')
  expect(await handlers.get(CH.connectGitHub)?.()).toEqual({ ok: true, value: null })
  expect(openExternal).toHaveBeenCalledOnce()

  handlers.clear()
  register('https://github.com.evil.example/install')
  expect(await handlers.get(CH.connectGitHub)?.()).toMatchObject({ ok: false })
  expect(openExternal).toHaveBeenCalledOnce()
})

it('reads the config once, and again after a failed read', async () => {
  let fail = true
  const config = vi.fn(async () => {
    if (fail) {
      throw new Error('offline')
    }
    return { idleSleepMinutes: 15 }
  })
  register('https://github.com/x', config)
  expect(await handlers.get(CH.getConfig)?.()).toBeNull()
  fail = false
  await handlers.get(CH.getConfig)?.()
  await handlers.get(CH.getConfig)?.()
  expect(config).toHaveBeenCalledTimes(2)
})
