import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Project } from '../../shared/project-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { resolveProjectDefaultAgent } from './project-default-agent-resolution'
import { detectAgentsOnHost } from '../preflight/workspace-agent-detection'
import { AgentResolveDefault } from '../../shared/rpc-contract/project-default-agent-params'

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

describe('agent.resolveDefault params', () => {
  it('accepts one host-qualified target and rejects ambiguous targets', () => {
    expect(AgentResolveDefault.safeParse({ repo: 'B', repoHostId: 'local' }).success).toBe(true)
    expect(
      AgentResolveDefault.parse({ repo: 'B', repoHostId: 'runtime:paired-host' }).repoHostId
    ).toBe('local')
    expect(AgentResolveDefault.safeParse({ repo: 'B', worktree: 'work' }).success).toBe(false)
    expect(AgentResolveDefault.safeParse({ repoHostId: 'local' }).success).toBe(false)
    expect(AgentResolveDefault.safeParse({ repo: 'B', repoHostId: 'bad-host' }).success).toBe(false)
    expect(AgentResolveDefault.safeParse({ repo: 'B', validateAgent: 'codex' }).success).toBe(true)
    expect(
      AgentResolveDefault.safeParse({ repo: 'B', validateAgent: 'not-an-agent' }).success
    ).toBe(false)
  })
})
