import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Project } from '../../shared/project-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { resolveProjectDefaultAgent } from './project-default-agent-resolution'
import { detectAgentsOnHost } from '../preflight/workspace-agent-detection'

vi.mock('../preflight/workspace-agent-detection', () => ({ detectAgentsOnHost: vi.fn() }))

const repo: Repo = {
  id: 'repo-b',
  path: '/projects/b',
  displayName: 'B',
  badgeColor: '#123456',
  addedAt: 1
}
const folder: FolderWorkspace = {
  id: 'folder-b',
  projectGroupId: 'group-b',
  name: 'B folder',
  folderPath: '/projects/b',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

function runtime(
  projectAgent?: Project['defaultTuiAgent'],
  globalAgent: 'claude' | null = 'claude'
) {
  const project: Project = {
    id: 'project-b',
    displayName: 'Project B',
    badgeColor: '#123456',
    sourceRepoIds: [repo.id],
    createdAt: 1,
    updatedAt: 1,
    ...(projectAgent !== undefined ? { defaultTuiAgent: projectAgent } : {})
  }
  return {
    requireStore: () => ({
      getProjects: () => [project],
      getProjectHostSetups: () => [
        {
          id: 'setup-b',
          projectId: project.id,
          repoId: repo.id,
          hostId: 'local' as const,
          path: repo.path,
          displayName: 'B',
          setupState: 'ready' as const,
          setupMethod: 'legacy-repo' as const,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      getRepos: () => [repo],
      getProjectGroups: () => [],
      getFolderWorkspaces: () => [],
      getWorktreeMeta: () => undefined
    }),
    getClientSettings: () => ({ defaultTuiAgent: globalAgent, disabledTuiAgents: [] }),
    showTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: 'repo-b::/projects/b/work',
      path: '/projects/b/work',
      repo,
      folderWorkspace: null
    })),
    resolveAgentDetectionHost: vi.fn(async () => ({ kind: 'local' as const }))
  }
}

describe('resolveProjectDefaultAgent', () => {
  it('selects the exact host owner when another host has the same repository ID', async () => {
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['codex', 'claude'])
    const host = runtime('codex')
    const store = host.requireStore()
    const other = { ...store.getProjects()[0], id: 'other', defaultTuiAgent: 'claude' as const }
    const target = {
      ...host,
      requireStore: () => ({
        ...store,
        getProjects: () => [other, ...store.getProjects()],
        getProjectHostSetups: () => [
          { ...store.getProjectHostSetups()[0], projectId: other.id, hostId: 'ssh:other' as const },
          ...store.getProjectHostSetups()
        ]
      })
    }
    await expect(resolveProjectDefaultAgent(target, { repo })).resolves.toMatchObject({
      agent: 'codex',
      projectId: 'project-b'
    })
  })

  it('refuses conflicting project owners on the same execution host', async () => {
    const host = runtime('codex')
    const store = host.requireStore()
    const target = {
      ...host,
      requireStore: () => ({
        ...store,
        getProjects: () => [...store.getProjects(), { ...store.getProjects()[0], id: 'other' }],
        getProjectHostSetups: () => [
          ...store.getProjectHostSetups(),
          { ...store.getProjectHostSetups()[0], id: 'other-setup', projectId: 'other' }
        ]
      })
    }
    await expect(resolveProjectDefaultAgent(target, { repo })).rejects.toThrow(/ambiguous/i)
  })

  it('uses the target project, including for an existing workspace', async () => {
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['codex', 'claude'])
    const host = runtime('codex')
    await expect(resolveProjectDefaultAgent(host, { repo })).resolves.toEqual({
      agent: 'codex',
      source: 'project',
      projectId: 'project-b',
      projectName: 'Project B'
    })
    await expect(
      resolveProjectDefaultAgent(host, { worktreeId: 'repo-b::/projects/b/work' })
    ).resolves.toMatchObject({ agent: 'codex', source: 'project' })
  })

  it('uses an existing workspace pinned project over a different repo association', async () => {
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['codex', 'claude'])
    const host = runtime('claude')
    const store = host.requireStore()
    const pinned = {
      ...host,
      requireStore: () => ({
        ...store,
        getProjects: () => [
          ...store.getProjects(),
          {
            ...store.getProjects()[0],
            id: 'pinned',
            displayName: 'Pinned',
            defaultTuiAgent: 'codex' as const
          }
        ],
        getWorktreeMeta: () => ({
          projectId: 'pinned',
          displayName: 'Pinned workspace',
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 1
        })
      })
    }
    await expect(
      resolveProjectDefaultAgent(pinned, { worktreeId: 'repo-b::/projects/b/work' })
    ).resolves.toMatchObject({ agent: 'codex', projectId: 'pinned' })
  })

  it('inherits global, preserves blank, and auto-picks only when global is unset', async () => {
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['codex', 'claude'])
    await expect(resolveProjectDefaultAgent(runtime(), { repo })).resolves.toMatchObject({
      agent: 'claude',
      source: 'global'
    })
    await expect(resolveProjectDefaultAgent(runtime('blank'), { repo })).resolves.toMatchObject({
      agent: null,
      source: 'project'
    })
    await expect(resolveProjectDefaultAgent(runtime(null, null), { repo })).resolves.toMatchObject({
      agent: 'claude',
      source: 'automatic'
    })
  })

  it('refuses unavailable configured agents instead of substituting another', async () => {
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['claude'])
    await expect(resolveProjectDefaultAgent(runtime('codex'), { repo })).rejects.toThrow(
      /Project B.*codex.*unavailable/i
    )
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['codex'])
    await expect(resolveProjectDefaultAgent(runtime(), { repo })).rejects.toThrow(
      /Project B.*claude.*unavailable/i
    )
  })

  it.each(['newer-agent', ''])(
    'refuses unknown persisted project or global choice %j',
    async (choice) => {
      vi.mocked(detectAgentsOnHost).mockResolvedValue(['claude'])
      const host = runtime()
      Object.assign(host.requireStore().getProjects()[0], { defaultTuiAgent: choice })
      await expect(resolveProjectDefaultAgent(host, { repo })).rejects.toThrow(
        /Project B.*not a known agent/i
      )
      const inherited = runtime()
      const settings = Object.assign(inherited.getClientSettings(), { defaultTuiAgent: choice })
      await expect(
        resolveProjectDefaultAgent({ ...inherited, getClientSettings: () => settings }, { repo })
      ).rejects.toThrow(/Project B.*not a known agent/i)
    }
  )

  it('validates a pinned retry agent on the target host without reselecting a changed default', async () => {
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['codex', 'claude'])
    await expect(
      resolveProjectDefaultAgent(runtime('claude'), { repo }, 'codex')
    ).resolves.toMatchObject({
      agent: 'codex',
      source: 'explicit',
      projectId: 'project-b'
    })
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['claude'])
    await expect(resolveProjectDefaultAgent(runtime('claude'), { repo }, 'codex')).rejects.toThrow(
      /Project B.*codex.*unavailable/i
    )
  })

  it('refuses a configured agent disabled on the execution host', async () => {
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['codex', 'claude'])
    const host = runtime('codex')
    const disabled = {
      ...host,
      getClientSettings: () => ({
        defaultTuiAgent: 'claude' as const,
        disabledTuiAgents: ['codex' as const]
      })
    }
    await expect(resolveProjectDefaultAgent(disabled, { repo })).rejects.toThrow(/codex.*disabled/i)
  })

  it('resolves a folder workspace through its target repository and execution host', async () => {
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['codex'])
    const host = runtime('codex')
    const first = host.requireStore()
    const folderHost = {
      ...host,
      requireStore: () => ({ ...first, getFolderWorkspaces: () => [folder] }),
      showTerminalWorkspaceLaunchScope: vi.fn(async () => ({
        id: 'folder:folder-b',
        path: folder.folderPath,
        repo: null,
        folderWorkspace: folder
      })),
      resolveAgentDetectionHost: vi.fn(async () => ({ kind: 'local' as const }))
    }
    await expect(
      resolveProjectDefaultAgent(folderHost, { worktreeId: 'folder:folder-b' })
    ).resolves.toMatchObject({
      agent: 'codex',
      source: 'project',
      projectId: 'project-b'
    })
    expect(folderHost.resolveAgentDetectionHost).toHaveBeenCalledWith('folder:folder-b', undefined)
  })

  it('uses the global setting when no project owns the target', async () => {
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['claude'])
    const host = runtime('codex')
    const first = host.requireStore()
    const unowned = {
      ...host,
      requireStore: () => ({ ...first, getProjects: () => [], getProjectHostSetups: () => [] })
    }
    await expect(resolveProjectDefaultAgent(unowned, { repo })).resolves.toEqual({
      agent: 'claude',
      source: 'global'
    })
  })

  it('fails closed when the target repo matches multiple projects', async () => {
    vi.mocked(detectAgentsOnHost).mockResolvedValue(['codex'])
    const host = runtime('codex')
    const first = host.requireStore()
    const ambiguous = {
      ...host,
      requireStore: () => ({
        ...first,
        getProjects: () => [
          ...first.getProjects(),
          { ...first.getProjects()[0], id: 'other', displayName: 'Other' }
        ],
        getProjectHostSetups: () => []
      })
    }
    await expect(resolveProjectDefaultAgent(ambiguous, { repo })).rejects.toThrow(/ambiguous/i)
  })
})
