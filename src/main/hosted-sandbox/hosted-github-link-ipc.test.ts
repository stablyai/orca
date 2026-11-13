// "Copy link" for Connect your GitHub (OAuth sign-in): the same page, minted the same way, returned
// instead of opened, and still only ever a github.com page. The App install has no link channel:
// Copy link is for sign-in pages only.
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
import { HOSTED_ACCOUNT_CHANNELS, registerHostedAccountHandlers } from './hosted-account-ipc'

const REPO = 'https://github.com/acme/web'
const SESSION = 'cs_abcdefghijklmnopqrstuv'

afterEach(() => {
  handlers.clear()
  vi.clearAllMocks()
})

function register(url: string) {
  const connectGitHub = vi.fn(async () => ({ installUrl: url, authorizeUrl: url }))
  const connectGitHubUser = vi.fn(async () => ({ authorizeUrl: url }))
  registerHostedAccountHandlers(
    {
      config: async () => {
        throw new Error('unused')
      },
      connectGitHub,
      githubRepoAccess: async () => ({ access: 'granted', owner: 'acme', repo: REPO }),
      githubRepositories: async () => ({ repositories: [], nextCursor: null }),
      create: async () => {
        throw new Error('unused')
      },
      bootPlan: async () => {
        throw new Error('unused')
      },
      cloneStatus: async () => {
        throw new Error('unused')
      },
      destroy: async () => {
        throw new Error('unused')
      },
      list: async () => {
        throw new Error('unused')
      },
      githubUser: async () => ({ connected: false as const }),
      connectGitHubUser,
      disconnectGitHubUser: async () => ({ connected: false as const })
    },
    { repoIds: async () => ({ repoId: 7, ownerId: 50 }) }
  )
  return { connectGitHub, connectGitHubUser }
}

it('registers the OAuth link channel, and no App-install link channel', () => {
  expect(HOSTED_ACCOUNT_CHANNELS).toContain(CH.gitHubUserConnectLink)
  expect(HOSTED_ACCOUNT_CHANNELS).not.toContain('orcaCloudWorkspace:gitHubInstallLink')
})

it('Connect GitHub still opens the install page minted for the repository', async () => {
  const url = 'https://github.com/apps/x/installations/new?state=s'
  const { connectGitHub } = register(url)
  expect(
    await handlers.get(CH.connectGitHub)?.({}, { repoUrl: REPO, setupSessionId: SESSION })
  ).toEqual({ ok: true, value: null })
  expect(connectGitHub).toHaveBeenLastCalledWith(undefined, {
    repo: REPO,
    setupSessionId: SESSION,
    repoId: 7,
    ownerId: 50
  })
  expect(openExternal).toHaveBeenCalledWith(url)
})

it('returns the OAuth page minted like Connect your GitHub, without opening it', async () => {
  const url = 'https://github.com/login/oauth/authorize?client_id=x&state=s'
  register(url)
  expect(await handlers.get(CH.gitHubUserConnectLink)?.()).toEqual({ ok: true, value: url })
  expect(openExternal).not.toHaveBeenCalled()
})

it('never opens or hands out a page that is not on github.com', async () => {
  for (const url of [
    'https://github.com.evil.example/install',
    'http://github.com/login/oauth/authorize',
    'https://evil.example/?next=https://github.com'
  ]) {
    handlers.clear()
    register(url)
    expect(await handlers.get(CH.connectGitHub)?.({}, {})).toMatchObject({
      ok: false,
      code: 'failed'
    })
    expect(await handlers.get(CH.gitHubUserConnectLink)?.()).toMatchObject({
      ok: false,
      code: 'failed'
    })
  }
  expect(openExternal).not.toHaveBeenCalled()
})
