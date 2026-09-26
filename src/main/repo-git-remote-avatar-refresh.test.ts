import { afterEach, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId, type ExecutionHostId } from '../shared/execution-host'
import { deriveGitRemoteIdentity } from '../shared/git-remote-identity'
import { projectHostSetupProjectionFromRepos } from '../shared/project-host-setup-projection'
import { githubAvatarIcon, type RepoIcon } from '../shared/repo-icon'
import type { Repo } from '../shared/repo-types'
import { probeGitRemoteIdentity, type GitRemoteIdentityProbe } from './repo-git-remote-identity'
import {
  enrichMissingRepoGitRemoteIdentities,
  flushRepoGitRemoteIdentityEnrichmentForTests,
  resetRepoGitRemoteIdentityEnrichmentForTests
} from './repo-git-remote-identity-enrichment'

vi.mock('./repo-git-remote-identity', () => ({ probeGitRemoteIdentity: vi.fn() }))

function identity(remote = 'https://github.com/org-b/app.git') {
  const parsed = deriveGitRemoteIdentity(`origin\t${remote} (fetch)`)
  if (!parsed) {
    throw new Error('Fixture remote must parse')
  }
  return parsed
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'app',
    path: '/workspace/app',
    displayName: 'app',
    kind: 'git',
    badgeColor: '',
    addedAt: 1,
    upstream: null,
    gitRemoteIdentity: identity(),
    repoIcon: githubAvatarIcon({ owner: 'owner-a', repo: 'app' }),
    ...overrides
  }
}

function storeFor(repos: Repo[]) {
  const getRepo = (id: string, hostId?: ExecutionHostId) =>
    repos.find((row) => row.id === id && (!hostId || getRepoExecutionHostId(row) === hostId))
  const updateRepo = vi.fn((id: string, updates: Partial<Repo>, hostId?: ExecutionHostId) => {
    const current = getRepo(id, hostId)
    if (!current) {
      return null
    }
    Object.assign(current, updates)
    return current
  })
  return { getRepos: () => repos, getRepo, updateRepo }
}

async function sweep(store: ReturnType<typeof storeFor>, onChanged = vi.fn()) {
  enrichMissingRepoGitRemoteIdentities(store, { onChanged })
  for (let i = 0; i < 8; i++) {
    await flushRepoGitRemoteIdentityEnrichmentForTests()
  }
}

async function refresh(store: ReturnType<typeof storeFor>, onChanged = vi.fn()) {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  await sweep(store, onChanged)
  expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
  vi.setSystemTime(301_001)
  await sweep(store, onChanged)
}

afterEach(() => {
  resetRepoGitRemoteIdentityEnrichmentForTests()
  vi.useRealTimers()
  vi.clearAllMocks()
})

it.each(['already-current', 'changed'])(
  'repairs a stale avatar when the canonical key is %s',
  async (mode) => {
    const local = repo({
      gitRemoteIdentity:
        mode === 'changed' ? identity('https://github.com/owner-a/app.git') : identity()
    })
    const peer = repo({
      id: 'peer',
      path: '/workspace/app',
      connectionId: 'build',
      repoIcon: githubAvatarIcon({ owner: 'org-b', repo: 'app' })
    })
    const store = storeFor([local, peer])
    const onChanged = vi.fn()
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
      status: 'resolved',
      identity: identity()
    })

    expect(projectHostSetupProjectionFromRepos(store.getRepos()).projects).toHaveLength(2)
    await refresh(store, onChanged)

    expect(local.repoIcon).toEqual(githubAvatarIcon({ owner: 'org-b', repo: 'app' }))
    expect(store.updateRepo).toHaveBeenCalledTimes(1)
    expect(onChanged).toHaveBeenCalledTimes(1)
    const projected = projectHostSetupProjectionFromRepos(store.getRepos())
    expect(projected.projects.map(({ id }) => id)).toEqual(['github:org-b/app'])
    expect(projected.setups.map(({ hostId, path }) => ({ hostId, path }))).toEqual([
      { hostId: 'local', path: '/workspace/app' },
      { hostId: 'ssh:build', path: '/workspace/app' }
    ])
    vi.setSystemTime(301_001 + 6 * 60 * 60 * 1000)
    await sweep(store, onChanged)
    expect(store.updateRepo).toHaveBeenCalledTimes(1)
  }
)

it.each([
  'https://github.company.test:8443/org-b/app.git',
  'ssh://git@ssh.github.com:443/org-b/app.git'
])('preserves GitHub endpoint identity for %s', async (remote) => {
  const row = repo({ gitRemoteIdentity: identity(remote) })
  const store = storeFor([row])
  vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
    status: 'resolved',
    identity: identity(remote)
  })
  await refresh(store)
  expect(projectHostSetupProjectionFromRepos([row]).projects[0]?.id).toBe(
    remote.includes('company') ? 'github:github.company.test:8443/org-b/app' : 'github:org-b/app'
  )
})

it.each([
  'git@github-work:org/app.git',
  'ssh://git@ghe-work/org/app.git',
  'https://gitlab.com/team/sub/app.git',
  'https://forgejo.test/team/app.git',
  'https://gitea.test/team/app.git',
  'https://code.company.test/team/app.git'
])('leaves provider metadata intact for unresolved or other-provider remote %s', async (remote) => {
  const row = repo({ gitRemoteIdentity: identity(remote) })
  const original = row.repoIcon
  const store = storeFor([row])
  vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
    status: 'resolved',
    identity: identity(remote)
  })
  await refresh(store)
  expect(row.repoIcon).toBe(original)
  expect(store.updateRepo).not.toHaveBeenCalled()
})

const customIcons: (RepoIcon | null | undefined)[] = [
  { type: 'emoji', emoji: '🐙' },
  { type: 'lucide', name: 'Folder' },
  { type: 'image', source: 'upload', src: 'data:image/png;base64,fixture', label: 'custom' },
  { type: 'image', source: 'file', src: 'data:image/png;base64,fixture', label: 'custom' },
  { type: 'image', source: 'favicon', src: 'https://website.test/favicon.png', label: 'custom' },
  null,
  undefined
]

it.each(customIcons)('preserves custom or cleared icon %j', async (repoIcon) => {
  const row = repo({ repoIcon })
  const store = storeFor([row])
  vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'resolved', identity: identity() })
  await refresh(store)
  expect(row.repoIcon).toBe(repoIcon)
  expect(store.updateRepo).not.toHaveBeenCalled()
})

it('preserves explicit upstream even when the remote disagrees', async () => {
  const row = repo({ upstream: { owner: 'parent', repo: 'app', host: 'github.parent.test' } })
  const original = row.repoIcon
  const store = storeFor([row])
  vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'resolved', identity: identity() })
  await refresh(store)
  expect(row.repoIcon).toBe(original)
  expect(projectHostSetupProjectionFromRepos([row]).projects[0]?.id).toBe(
    'github:github.parent.test/parent/app'
  )
  expect(store.updateRepo).not.toHaveBeenCalled()
})

it.each(['unavailable', 'no-remote'] as const)(
  'preserves the last avatar when a refresh is %s',
  async (status) => {
    const row = repo()
    const original = row.repoIcon
    const store = storeFor([row])
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status })
    await refresh(store)
    expect(row.repoIcon).toBe(original)
    expect(store.updateRepo).not.toHaveBeenCalled()
  }
)

it.each(['same', 'different', 'missing'] as const)(
  'never probes or writes peer-owned metadata when identity is %s',
  async (kind) => {
    const row = repo({
      executionHostId: 'runtime:peer',
      connectionId: 'nested',
      gitRemoteIdentity:
        kind === 'missing'
          ? undefined
          : identity(kind === 'different' ? 'https://github.com/peer-only/app.git' : undefined)
    })
    const originalIcon = row.repoIcon
    const originalIdentity = row.gitRemoteIdentity
    const store = storeFor([row])
    vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
      status: 'resolved',
      identity: identity()
    })
    await (kind === 'missing' ? sweep(store) : refresh(store))
    expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
    expect(row.repoIcon).toBe(originalIcon)
    expect(row.gitRemoteIdentity).toBe(originalIdentity)
    expect(store.updateRepo).not.toHaveBeenCalled()
  }
)

it('repairs only the matching owner when repo IDs and paths collide across hosts', async () => {
  const local = repo({ repoIcon: githubAvatarIcon({ owner: 'org-b', repo: 'app' }) })
  const ssh = repo({ executionHostId: 'ssh:build' })
  const store = storeFor([local, ssh])
  vi.mocked(probeGitRemoteIdentity).mockResolvedValue({ status: 'resolved', identity: identity() })
  await refresh(store)
  expect(store.updateRepo).toHaveBeenCalledWith(
    'app',
    { repoIcon: githubAvatarIcon({ owner: 'org-b', repo: 'app' }) },
    'ssh:build'
  )
  expect(projectHostSetupProjectionFromRepos([local, ssh]).projects).toHaveLength(1)
})

it.each(['ssh:build', 'runtime:peer'] as const)(
  'keeps local metadata writes scoped when a same-id %s row comes first',
  async (hostId) => {
    const foreignIdentity = identity('https://github.com/foreign/app.git')
    const foreignIcon = githubAvatarIcon({ owner: 'foreign', repo: 'app' })
    const foreign = repo({
      executionHostId: hostId,
      gitRemoteIdentity: foreignIdentity,
      repoIcon: foreignIcon
    })
    const local = repo({ gitRemoteIdentity: identity('https://github.com/old-local/app.git') })
    const store = storeFor([foreign, local])
    vi.mocked(probeGitRemoteIdentity).mockImplementation(async (_path, probeHostId) => ({
      status: 'resolved',
      identity: probeHostId === 'local' ? identity() : foreignIdentity
    }))
    await refresh(store)
    expect(foreign.gitRemoteIdentity).toBe(foreignIdentity)
    expect(foreign.repoIcon).toBe(foreignIcon)
    expect(local.gitRemoteIdentity).toEqual(identity())
    expect(local.repoIcon).toEqual(githubAvatarIcon({ owner: 'org-b', repo: 'app' }))
    expect(store.updateRepo).toHaveBeenCalledExactlyOnceWith(
      'app',
      { gitRemoteIdentity: identity(), repoIcon: local.repoIcon },
      'local'
    )
  }
)

it('does not write after a pending local probe becomes peer-owned', async () => {
  let answer: ((value: GitRemoteIdentityProbe) => void) | undefined
  const row = repo({ gitRemoteIdentity: undefined })
  const originalIcon = row.repoIcon
  const store = storeFor([row])
  vi.mocked(probeGitRemoteIdentity).mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  enrichMissingRepoGitRemoteIdentities(store)
  row.executionHostId = 'runtime:peer'
  if (!answer) {
    throw new Error('Expected pending probe')
  }
  answer({ status: 'resolved', identity: identity() })
  await flushRepoGitRemoteIdentityEnrichmentForTests()
  expect(row.gitRemoteIdentity).toBeUndefined()
  expect(row.repoIcon).toBe(originalIcon)
  expect(store.updateRepo).not.toHaveBeenCalled()
})

it('does not overwrite a custom icon selected while the probe is pending', async () => {
  let answer: ((value: GitRemoteIdentityProbe) => void) | undefined
  const row = repo({ gitRemoteIdentity: undefined })
  const store = storeFor([row])
  vi.mocked(probeGitRemoteIdentity).mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  enrichMissingRepoGitRemoteIdentities(store)
  const selected: RepoIcon = { type: 'emoji', emoji: '🐙' }
  row.repoIcon = selected
  if (!answer) {
    throw new Error('Expected pending probe')
  }
  answer({ status: 'resolved', identity: identity() })
  await flushRepoGitRemoteIdentityEnrichmentForTests()
  expect(row.repoIcon).toBe(selected)
  expect(store.updateRepo).toHaveBeenCalledWith('app', { gitRemoteIdentity: identity() }, 'local')
})

it('never probes folder workspaces for an avatar repair', async () => {
  const store = storeFor([repo({ kind: 'folder' })])
  await refresh(store)
  expect(probeGitRemoteIdentity).not.toHaveBeenCalled()
  expect(store.updateRepo).not.toHaveBeenCalled()
})
