import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type * as LinearIssuesModule from '../../../linear/issues'

type LinearProjectResolverTester = {
  resolveLinearCreateProject(
    input: string,
    team: { id: string; workspaceId: string }
  ): Promise<{
    id: string
    name: string
  }>
  readLinearProjectByIdForCreate(id: string, workspaceId: string): Promise<unknown | null>
  readLinearProjectsForCreate(query: string, workspaceId: string): Promise<unknown[]>
  readLinearProjectsByExactNameForCreate(name: string, workspaceId: string): Promise<unknown[]>
}

type LinearCreateTester = LinearProjectResolverTester & {
  resolveLinearCreateTeam(
    teamInput: string | undefined,
    workspaceId: string | undefined,
    parent: unknown
  ): Promise<{ id: string; key: string; name: string; workspaceId: string }>
}

describe('Linear agent project access helpers', () => {
  it('resolves Linear projects by UUID before searching names', async () => {
    const runtime = new OrcaRuntimeService()
    const tester = runtime as unknown as LinearProjectResolverTester
    const readById = vi.spyOn(tester, 'readLinearProjectByIdForCreate').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Launch',
      teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }]
    } as never)
    const readByName = vi
      .spyOn(tester, 'readLinearProjectsForCreate')
      .mockResolvedValue([] as never)

    await expect(
      tester.resolveLinearCreateProject('11111111-1111-4111-8111-111111111111', {
        id: 'team-1',
        workspaceId: 'workspace-1'
      })
    ).resolves.toMatchObject({ id: '11111111-1111-4111-8111-111111111111' })
    expect(readById).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'workspace-1')
    expect(readByName).not.toHaveBeenCalled()
  })

  it('resolves Linear projects by trimmed case-insensitive exact name', async () => {
    const runtime = new OrcaRuntimeService()
    const tester = runtime as unknown as LinearProjectResolverTester
    vi.spyOn(tester, 'readLinearProjectByIdForCreate').mockResolvedValue(null as never)
    const readByName = vi.spyOn(tester, 'readLinearProjectsForCreate').mockResolvedValue([
      {
        id: 'project-1',
        name: 'Launch',
        teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }]
      }
    ] as never)
    const readExactName = vi
      .spyOn(tester, 'readLinearProjectsByExactNameForCreate')
      .mockResolvedValue([
        {
          id: 'project-1',
          name: 'Launch',
          teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }]
        }
      ] as never)

    await expect(
      tester.resolveLinearCreateProject(' launch ', { id: 'team-1', workspaceId: 'workspace-1' })
    ).resolves.toMatchObject({ id: 'project-1' })
    expect(readByName).toHaveBeenCalledWith('launch', 'workspace-1')
    expect(readExactName).toHaveBeenCalledWith('launch', 'workspace-1')
  })

  it('resolves same-named Linear projects by target team compatibility', async () => {
    const runtime = new OrcaRuntimeService()
    const tester = runtime as unknown as LinearProjectResolverTester
    vi.spyOn(tester, 'readLinearProjectByIdForCreate').mockResolvedValue(null as never)
    vi.spyOn(tester, 'readLinearProjectsForCreate').mockResolvedValue([] as never)
    vi.spyOn(tester, 'readLinearProjectsByExactNameForCreate').mockResolvedValue([
      {
        id: 'project-1',
        name: 'Launch',
        teams: [{ id: 'team-other', name: 'Other', key: 'OTH' }]
      },
      {
        id: 'project-2',
        name: 'launch',
        teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }]
      }
    ] as never)

    await expect(
      tester.resolveLinearCreateProject('Launch', { id: 'team-1', workspaceId: 'workspace-1' })
    ).resolves.toMatchObject({ id: 'project-2' })
  })

  it('rejects ambiguous Linear project names with candidate ids', async () => {
    const runtime = new OrcaRuntimeService()
    const tester = runtime as unknown as LinearProjectResolverTester
    vi.spyOn(tester, 'readLinearProjectByIdForCreate').mockResolvedValue(null as never)
    vi.spyOn(tester, 'readLinearProjectsForCreate').mockResolvedValue([] as never)
    vi.spyOn(tester, 'readLinearProjectsByExactNameForCreate').mockResolvedValue([
      {
        id: 'project-1',
        name: 'Launch',
        teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }]
      },
      {
        id: 'project-2',
        name: 'launch',
        teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }]
      }
    ] as never)

    await expect(
      tester.resolveLinearCreateProject('Launch', { id: 'team-1', workspaceId: 'workspace-1' })
    ).rejects.toMatchObject({
      code: 'linear_invalid_project',
      data: {
        projects: [
          { id: 'project-1', name: 'Launch' },
          { id: 'project-2', name: 'launch' }
        ]
      }
    })
  })

  it('fails closed when Linear project team membership cannot be verified', async () => {
    const runtime = new OrcaRuntimeService()
    const tester = runtime as unknown as LinearProjectResolverTester
    vi.spyOn(tester, 'readLinearProjectByIdForCreate').mockResolvedValue(null as never)
    vi.spyOn(tester, 'readLinearProjectsForCreate').mockResolvedValue([] as never)
    vi.spyOn(tester, 'readLinearProjectsByExactNameForCreate').mockResolvedValue([
      {
        id: 'project-1',
        name: 'Launch'
      }
    ] as never)

    await expect(
      tester.resolveLinearCreateProject('Launch', { id: 'team-1', workspaceId: 'workspace-1' })
    ).rejects.toMatchObject({
      code: 'linear_invalid_project',
      data: { project: { id: 'project-1', name: 'Launch', teams: [] } }
    })
  })

  it('caps agent project lists globally and returns a narrow project DTO', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'linearListProjects').mockResolvedValue({
      items: [
        {
          id: 'project-1',
          name: 'Launch',
          url: 'https://linear.app/acme/project/launch',
          workspaceId: 'workspace-1',
          workspaceName: 'Acme',
          content: 'internal notes',
          description: 'roadmap',
          teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }]
        },
        {
          id: 'project-2',
          name: 'Follow-up',
          workspaceId: 'workspace-2',
          workspaceName: 'Beta'
        }
      ],
      hasMore: false
    } as never)

    const result = await runtime.linearProjectListForAgents({ limit: 1, workspaceId: 'all' })

    expect(result.projects).toHaveLength(1)
    expect(result.projects[0]).toMatchObject({
      id: 'project-1',
      name: 'Launch',
      url: 'https://linear.app/acme/project/launch',
      workspaceId: 'workspace-1',
      workspaceName: 'Acme',
      teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }]
    })
    expect(result.projects[0]).not.toHaveProperty('content')
    expect(result.projects[0]).not.toHaveProperty('description')
    expect(result.meta).toMatchObject({ limit: 1, returned: 1, hasMore: true })
  })

  it('passes the resolved project id into agent issue create', async () => {
    vi.resetModules()
    const createIssueForAgent = vi.fn().mockResolvedValue({
      id: 'issue-created',
      identifier: 'ENG-123',
      title: 'Follow up',
      url: 'https://linear.app/acme/issue/ENG-123',
      team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
      state: null,
      parent: null,
      project: { id: 'project-1', name: 'Launch' }
    })
    vi.doMock('../../../linear/issues', async (importOriginal) => {
      const actual = await importOriginal<typeof LinearIssuesModule>()
      return { ...actual, createIssueForAgent }
    })
    try {
      const { OrcaRuntimeService: RuntimeService } = await import('../../orca-runtime')
      const runtime = new RuntimeService()
      const tester = runtime as unknown as LinearCreateTester
      vi.spyOn(tester, 'resolveLinearCreateTeam').mockResolvedValue({
        id: 'team-1',
        key: 'ENG',
        name: 'Engineering',
        workspaceId: 'workspace-1'
      })
      vi.spyOn(tester, 'resolveLinearCreateProject').mockResolvedValue({
        id: 'project-1',
        name: 'Launch'
      } as never)

      const result = await runtime.linearIssueCreate({
        title: 'Follow up',
        teamInput: 'ENG',
        projectInput: 'Launch',
        writeId: '33333333-3333-4333-8333-333333333333'
      })

      expect(result.issue.project).toMatchObject({ id: 'project-1', name: 'Launch' })
      expect(createIssueForAgent).toHaveBeenCalledWith(
        'team-1',
        'Follow up',
        undefined,
        'workspace-1',
        expect.objectContaining({
          id: '33333333-3333-4333-8333-333333333333',
          parentId: null,
          projectId: 'project-1'
        })
      )
    } finally {
      vi.doUnmock('../../../linear/issues')
      vi.resetModules()
    }
  })
})
