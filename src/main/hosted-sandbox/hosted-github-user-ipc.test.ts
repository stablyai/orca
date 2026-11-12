import { afterEach, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  },
  shell: { openExternal }
}))

import { ORCA_CLOUD_WORKSPACE_CHANNELS as CH } from '../../shared/hosted-sandbox/cloud-workspace-api'
import { registerHostedGitHubUserHandlers } from './hosted-github-user-ipc'

afterEach(() => {
  handlers.clear()
  vi.clearAllMocks()
})

function register(authorizeUrl: string) {
  const client = {
    githubUser: vi.fn(async () => ({
      connected: true as const,
      login: 'octocat',
      githubUserId: 583231
    })),
    connectGitHubUser: vi.fn(async () => ({ authorizeUrl })),
    disconnectGitHubUser: vi.fn(async () => ({ connected: false as const }))
  }
  registerHostedGitHubUserHandlers(client)
  return client
}

it('opens the GitHub OAuth page only when its origin is exactly https://github.com', async () => {
  register('https://github.com/login/oauth/authorize?client_id=x&state=s')
  expect(await handlers.get(CH.connectGitHubUser)?.()).toEqual({ ok: true, value: null })
  expect(openExternal).toHaveBeenCalledWith(
    'https://github.com/login/oauth/authorize?client_id=x&state=s'
  )

  for (const url of [
    'https://github.com.evil.example/login/oauth/authorize',
    'http://github.com/login/oauth/authorize',
    'https://gist.github.com/login/oauth/authorize',
    'https://evil.example/?next=https://github.com'
  ]) {
    handlers.clear()
    register(url)
    expect(await handlers.get(CH.connectGitHubUser)?.()).toMatchObject({
      ok: false,
      code: 'failed'
    })
  }
  expect(openExternal).toHaveBeenCalledOnce()
})

it('answers status and disconnect in the shared result shape, and a failure as failed', async () => {
  const client = register('https://github.com/login/oauth/authorize')
  expect(await handlers.get(CH.getGitHubUser)?.()).toEqual({
    ok: true,
    value: { connected: true, login: 'octocat', githubUserId: 583231 }
  })
  expect(await handlers.get(CH.disconnectGitHubUser)?.()).toEqual({
    ok: true,
    value: { connected: false }
  })
  client.githubUser.mockRejectedValueOnce(new Error('offline'))
  expect(await handlers.get(CH.getGitHubUser)?.()).toMatchObject({ ok: false })
})
