import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

const { pruneLineageMock, pruneMetadataMock } = vi.hoisted(() => ({
  pruneLineageMock: vi.fn(),
  pruneMetadataMock: vi
    .fn()
    .mockResolvedValue({ scanGenerationCurrent: true, preservedMetadataCandidateIds: new Set() })
}))
vi.mock('../../../workspaces/catalog/worktree-lineage-pruning', () => ({
  pruneLineageForMissingRepoWorktrees: pruneLineageMock
}))
vi.mock(
  '../../../ipc/worktrees/listing/authoritative-local-worktree-metadata-pruning',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    pruneMetadataMissingFromAuthoritativeLocalScan: pruneMetadataMock
  })
)
const { hiddenHostIds } = vi.hoisted(() => ({ hiddenHostIds: new Set<string>() }))
vi.mock('./runtime-visible-catalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runtimeHiddenHostIds: () => hiddenHostIds
}))
vi.mock(
  '../../../workspaces/execution-host/project-runtime-git-options',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getLocalProjectWorktreeGitOptions: () => ({})
  })
)

import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'

import type { RuntimeStore } from '../../construction/runtime-store-contract'

const settings: ReturnType<RuntimeStore['getSettings']> = {
  workspaceDir: '/worktrees',
  nestWorkspaces: true,
  refreshLocalBaseRefOnWorktreeCreate: false,
  branchPrefix: 'none',
  branchPrefixCustom: ''
}

function folderRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/app',
    displayName: 'Local app',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'folder',
    ...overrides
  }
}

function metadata(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function queries(
  store: RuntimeStore,
  overrides: Partial<ConstructorParameters<typeof RuntimeManagedWorktreeQueries>[0]> = {}
): RuntimeManagedWorktreeQueries {
  return new RuntimeManagedWorktreeQueries({
    getStore: () => store,
    listResolved: async () => [],
    resolveRepo: async () => store.getRepos()[0]!,
    selectRepos: () => store.getRepos(),
    scanRepo: async () => ({ ok: true, worktrees: [] }),
    listKnownHostIds: () => [],
    ...overrides
  })
}

describe('RuntimeManagedWorktreeQueries.listDetected', () => {
  it("does not project another host's folder metadata", async () => {
    const local = folderRepo()
    const remote = folderRepo({ connectionId: 'build-box', displayName: 'Remote app' })
    const rootId = `${local.id}::${local.path}`
    const foreignMeta = metadata({ displayName: 'Wrong host', hostId: 'ssh:build-box' })
    const store = {
      getRepos: () => [local, remote],
      getRepo: () => local,
      getAllWorktreeMeta: () => ({ [rootId]: foreignMeta }),
      getWorktreeMeta: () => foreignMeta,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore

    const result = await queries(store).listDetected(local)

    expect(result.worktrees).toHaveLength(1)
    expect(result.worktrees[0]).toMatchObject({
      id: rootId,
      hostId: 'local',
      displayName: 'Local app'
    })
  })
})

describe('RuntimeManagedWorktreeQueries.list host scope', () => {
  // Measured on hardware before this fix, same runtime and same refusing SSH host in the same
  // second: the UNSCOPED listing reported `omittedHostIds: ["local","ssh:ssh-scope-refused"]` with
  // `--host` selectors, while the SCOPED listing reported `{"hostIds":[],"omittedHostIds":[]}`.
  // A listing that covered nothing, reporting no gaps, is indistinguishable from a repo that
  // genuinely has no worktrees -- the thing docs/reference/ssh-execution-boundary.md forbids.
  function sshStore(): RuntimeStore {
    const repo = folderRepo({
      id: 'repo-ssh',
      kind: 'git',
      connectionId: 'conn-1',
      path: '/home/dev/app'
    })
    return {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore
  }

  it('names the scoped repo host as omitted when the listing covered nothing', async () => {
    const result = await queries(sshStore()).list('repo-ssh', 50)

    expect(result.totalCount).toBe(0)
    expect(result.hostScope).toEqual({
      hostIds: [],
      omittedHostIds: ['ssh:conn-1']
    })
  })

  // A selector still resolves a converted host's retained repo; its host must not leak back out.
  it('never names a hidden host, even for a selector that resolves to its repo', async () => {
    hiddenHostIds.add('ssh:conn-1')
    try {
      const result = await queries(sshStore()).list('repo-ssh', 50)
      expect(result.hostScope?.omittedHostIds).toEqual([])
    } finally {
      hiddenHostIds.clear()
    }
  })
})
