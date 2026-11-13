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
import { registerHostedAccountHandlers } from './hosted-account-ipc'

afterEach(() => {
  handlers.clear()
  vi.clearAllMocks()
})

function register(installUrl: string, config = vi.fn(async () => ({ idleSleepMinutes: 15 }))) {
  registerHostedAccountHandlers(
    {
      config,
      connectGitHub: async () => ({ installUrl, authorizeUrl: installUrl }),
      githubRepoAccess: async () => ({ access: 'granted', owner: 'acme', repo: REPO }),
      githubRepositories: async () => ({ repositories: [], nextCursor: null }),
      create: unusedCreate,
      ...githubUser
    },
    { repoIds: async () => null }
  )
  return config
}

const REPO = 'https://github.com/acme/web'
const githubUser = {
  githubUser: async () => ({ connected: false as const }),
  connectGitHubUser: async () => ({ authorizeUrl: 'https://github.com/login/oauth/authorize' }),
  disconnectGitHubUser: async () => ({ connected: false as const }),
  // The GitHub-only create's progress (GH-CREATE-SHEET): an older control plane has no boot plan.
  bootPlan: async (): Promise<'clone' | 'update'> => {
    throw new Error('not_found')
  },
  cloneStatus: async () => ({ state: 'done' as const }),
  destroy: async (id: string) => ({ id, status: 'destroyed' as const })
}
const unusedCreate = async (): Promise<never> => {
  throw new Error('not called')
}

it('starts a sandbox that clones a GitHub-only repository (D4), and refuses anything else', async () => {
  const create = vi.fn(async (body: { workspaceId: string; repo?: { url: string } }) => ({
    sandbox: {
      id: 'sbx_1',
      workspaceId: body.workspaceId,
      status: 'running' as const,
      machineSize: 'standard' as const,
      region: 'iad1',
      session: null,
      createdAt: 1
    },
    connection: { type: 'orca-server' as const, pairingCode: 'code', projectRoot: '/work' }
  }))
  registerHostedAccountHandlers(
    {
      config: async () => ({ idleSleepMinutes: 15 }),
      connectGitHub: async () => ({ installUrl: REPO, authorizeUrl: REPO }),
      githubRepoAccess: async () => ({ access: 'granted', owner: 'acme', repo: REPO }),
      githubRepositories: async () => ({ repositories: [], nextCursor: null }),
      create,
      ...githubUser
    },
    { repoIds: async () => null }
  )
  expect(await handlers.get(CH.createFromGitHub)?.({}, { repoUrl: REPO })).toEqual({
    ok: true,
    value: { sandboxId: 'sbx_1' }
  })
  expect(create).toHaveBeenLastCalledWith(
    {
      workspaceId: expect.stringMatching(/^web-[0-9a-f]{8}$/),
      machineSize: 'standard',
      repo: { url: 'https://github.com/acme/web.git' }
    },
    undefined,
    undefined
  )
  expect(
    await handlers.get(CH.createFromGitHub)?.({}, { repoUrl: 'https://gitlab.com/acme/web' })
  ).toMatchObject({ ok: false })
  expect(create).toHaveBeenCalledTimes(1)
})

it('a GitHub-only create keeps the typed name as the workspace title (NAME-DROPPED)', async () => {
  const create = vi.fn(async (body: { workspaceId: string; title?: string }) => ({
    sandbox: {
      id: 'sbx_2',
      workspaceId: body.workspaceId,
      status: 'running' as const,
      machineSize: 'standard' as const,
      region: 'iad1',
      session: null,
      createdAt: 1
    },
    connection: { type: 'orca-server' as const, pairingCode: 'code', projectRoot: '/work' }
  }))
  registerHostedAccountHandlers(
    {
      config: async () => ({ idleSleepMinutes: 15 }),
      connectGitHub: async () => ({ installUrl: REPO, authorizeUrl: REPO }),
      githubRepoAccess: async () => ({ access: 'granted', owner: 'acme', repo: REPO }),
      githubRepositories: async () => ({ repositories: [], nextCursor: null }),
      create,
      ...githubUser
    },
    { repoIds: async () => null }
  )
  await handlers.get(CH.createFromGitHub)?.({}, { repoUrl: REPO, title: '  ik-paired  ' })
  expect(create.mock.lastCall?.[0]).toEqual(expect.objectContaining({ title: 'ik-paired' }))
  // No name typed: no title (lists fall back to the repository's name), never an empty one.
  await handlers.get(CH.createFromGitHub)?.({}, { repoUrl: REPO, title: '   ' })
  expect(create.mock.lastCall?.[0]).toEqual(
    expect.not.objectContaining({ title: expect.anything() })
  )
  // The control plane caps titles at 120.
  await handlers.get(CH.createFromGitHub)?.({}, { repoUrl: REPO, title: 'x'.repeat(200) })
  expect(create.mock.lastCall?.[0]).toEqual(expect.objectContaining({ title: 'x'.repeat(120) }))
})
const SESSION = 'cs_abcdefghijklmnopqrstuv'

it('asks again with the repo and owner ids when access is missing, so GitHub preselects the repo', async () => {
  const githubRepoAccess = vi.fn(async (query: { repoId?: number }) => ({
    access: 'missing' as const,
    owner: 'acme',
    repo: REPO,
    installUrl: query.repoId
      ? 'https://github.com/apps/x/installations/new/permissions?suggested_target_id=50&repository_ids[]=7&state=s'
      : 'https://github.com/apps/x/installations/new?state=s'
  }))
  const connectGitHub = vi.fn(async () => ({
    installUrl: 'https://github.com/apps/x/installations/new?state=s',
    authorizeUrl: 'https://github.com/login/oauth/authorize'
  }))
  registerHostedAccountHandlers(
    {
      config: async () => ({ idleSleepMinutes: 15 }),
      connectGitHub,
      githubRepoAccess,
      githubRepositories: async () => ({ repositories: [], nextCursor: null }),
      create: unusedCreate,
      ...githubUser
    },
    { repoIds: async () => ({ repoId: 7, ownerId: 50 }) }
  )
  const answer = await handlers.get(CH.getRepoAccess)?.(
    {},
    { repoUrl: `${REPO}.git`, setupSessionId: SESSION }
  )
  expect(answer).toMatchObject({
    ok: true,
    value: { access: 'missing', installUrl: expect.stringContaining('repository_ids[]=7') }
  })
  expect(githubRepoAccess).toHaveBeenLastCalledWith({
    repo: REPO,
    setupSessionId: SESSION,
    repoId: 7,
    ownerId: 50
  })
  // Not GitHub: refused without a network call.
  expect(
    await handlers.get(CH.getRepoAccess)?.({}, { repoUrl: 'https://gitlab.com/acme/web' })
  ).toMatchObject({ ok: false })
  // Connect with a repo carries the ids and the session; a malformed session id is dropped.
  await handlers.get(CH.connectGitHub)?.({}, { repoUrl: REPO, setupSessionId: 'nope' })
  expect(connectGitHub).toHaveBeenLastCalledWith(undefined, { repo: REPO, repoId: 7, ownerId: 50 })
})

it('opens only a github.com page for Connect GitHub', async () => {
  register('https://github.com/apps/orca-cloud-dev/installations/new?state=x')
  expect(await handlers.get(CH.connectGitHub)?.()).toEqual({ ok: true, value: null })
  expect(openExternal).toHaveBeenCalledOnce()

  handlers.clear()
  register('https://github.com.evil.example/install')
  expect(await handlers.get(CH.connectGitHub)?.()).toMatchObject({ ok: false })
  expect(openExternal).toHaveBeenCalledOnce()
})

it('re-reads the config after 5 minutes so a new build sheet sees a fresh median', async () => {
  vi.useFakeTimers({ now: 0 })
  try {
    const config = register('https://github.com/x')
    await handlers.get(CH.getConfig)?.()
    vi.setSystemTime(4 * 60_000)
    await handlers.get(CH.getConfig)?.()
    expect(config).toHaveBeenCalledTimes(1)
    vi.setSystemTime(5 * 60_000)
    await handlers.get(CH.getConfig)?.()
    expect(config).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
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
