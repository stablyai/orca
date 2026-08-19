import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import type { LinearResolvedProject } from './project-target-resolution'

const rawRequestAcme = vi.fn()
const rawRequestGlobex = vi.fn()
const getClients = vi.fn()
const getStatus = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: vi.fn()
}))

vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  getStatus: () => getStatus(),
  isAuthError: vi.fn().mockReturnValue(false)
}))

function entry(id: string, name: string, rawRequest: unknown): LinearClientForWorkspace {
  return {
    workspace: {
      id,
      organizationId: id,
      organizationName: name,
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    apiKey: 'key',
    client: { client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

const acme = entry('workspace-acme', 'Acme', rawRequestAcme)
const globex = entry('workspace-globex', 'Globex', rawRequestGlobex)

const workspaces = [
  {
    id: 'workspace-acme',
    organizationId: 'workspace-acme',
    organizationName: 'Acme',
    organizationUrlKey: 'acme',
    displayName: 'Ada',
    email: 'ada@example.com'
  },
  {
    id: 'workspace-globex',
    organizationId: 'workspace-globex',
    organizationName: 'Globex',
    organizationUrlKey: 'globex',
    displayName: 'Ada',
    email: 'ada@example.com'
  }
]

function projectNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'project-1',
    name: 'Launch',
    slugId: 'launch-abc',
    url: 'https://linear.app/acme/project/launch-abc',
    teams: { nodes: [{ id: 'team-1', name: 'Core', key: 'CORE' }] },
    ...overrides
  }
}

function exactResponse(options: {
  bySlug?: Record<string, unknown>[]
  byName?: Record<string, unknown>[]
  slugHasMore?: boolean
  nameHasMore?: boolean
}): unknown {
  return {
    data: {
      bySlug: {
        nodes: options.bySlug ?? [],
        pageInfo: { hasNextPage: options.slugHasMore === true }
      },
      byName: {
        nodes: options.byName ?? [],
        pageInfo: { hasNextPage: options.nameHasMore === true }
      }
    }
  }
}

async function resolve(input: string, workspaceId?: string): Promise<LinearResolvedProject> {
  const { resolveLinearProjectTarget } = await import('./project-target-resolution')
  return await resolveLinearProjectTarget(input, workspaceId)
}

describe('Linear project target resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getStatus.mockReturnValue({ workspaces })
    getClients.mockImplementation((selection?: string) =>
      selection === 'all' || selection === undefined
        ? [acme, globex]
        : [acme, globex].filter((client) => client.workspace.id === selection)
    )
  })

  it('resolves a UUID through the direct project lookup only', async () => {
    rawRequestAcme.mockResolvedValueOnce({ data: { project: projectNode() } })
    rawRequestGlobex.mockResolvedValueOnce({ data: { project: null } })

    const resolved = await resolve('11111111-2222-4333-8444-555555555555')

    expect(resolved).toEqual({
      id: 'project-1',
      name: 'Launch',
      slugId: 'launch-abc',
      url: 'https://linear.app/acme/project/launch-abc',
      workspaceId: 'workspace-acme',
      workspaceName: 'Acme',
      resolvedBy: 'uuid'
    })
    expect(rawRequestAcme.mock.calls[0][0]).toContain('project(id: $id)')
    expect(rawRequestAcme).toHaveBeenCalledTimes(1)
  })

  it('does not fall through to name or slug lookup when a UUID misses', async () => {
    rawRequestAcme.mockResolvedValueOnce({ data: { project: null } })
    rawRequestGlobex.mockRejectedValueOnce(new Error('Entity not found: Project'))

    await expect(resolve('11111111-2222-4333-8444-555555555555')).rejects.toMatchObject({
      code: 'linear_invalid_project',
      message: 'No Linear project exactly matched "11111111-2222-4333-8444-555555555555".'
    })
    expect(rawRequestAcme).toHaveBeenCalledTimes(1)
    expect(rawRequestGlobex).toHaveBeenCalledTimes(1)
  })

  it('resolves an exact slug match as slug', async () => {
    rawRequestAcme.mockResolvedValueOnce(exactResponse({ bySlug: [projectNode()] }))
    rawRequestGlobex.mockResolvedValueOnce(exactResponse({}))

    const resolved = await resolve('launch-abc')

    expect(resolved.resolvedBy).toBe('slug')
    expect(rawRequestAcme.mock.calls[0][0]).toContain('slugId: { eqIgnoreCase: $term }')
    expect(rawRequestAcme.mock.calls[0][0]).toContain('name: { eqIgnoreCase: $term }')
    expect(rawRequestAcme.mock.calls[0][1]).toEqual({ term: 'launch-abc' })
  })

  it('resolves an exact name match as name', async () => {
    rawRequestAcme.mockResolvedValueOnce(exactResponse({ byName: [projectNode()] }))
    rawRequestGlobex.mockResolvedValueOnce(exactResponse({}))

    expect((await resolve('Launch')).resolvedBy).toBe('name')
  })

  it('prefers slug when one project satisfies both exact forms', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      exactResponse({ bySlug: [projectNode()], byName: [projectNode()] })
    )
    rawRequestGlobex.mockResolvedValueOnce(exactResponse({}))

    expect((await resolve('launch')).resolvedBy).toBe('slug')
  })

  it('fails when a slug match and a different exact-name match collide', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      exactResponse({
        bySlug: [projectNode()],
        byName: [projectNode({ id: 'project-2', name: 'launch', slugId: 'other-def' })]
      })
    )
    rawRequestGlobex.mockResolvedValueOnce(exactResponse({}))

    await expect(resolve('launch')).rejects.toMatchObject({
      code: 'linear_invalid_project',
      data: {
        projects: [{ id: 'project-1' }, { id: 'project-2' }]
      }
    })
  })

  it('treats another exact page as proof of ambiguity', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      exactResponse({ byName: [projectNode()], nameHasMore: true })
    )
    rawRequestGlobex.mockResolvedValueOnce(exactResponse({}))

    await expect(resolve('Launch')).rejects.toMatchObject({ code: 'linear_invalid_project' })
  })

  it('reports duplicate names across workspaces with workspace-qualified candidates', async () => {
    rawRequestAcme.mockResolvedValueOnce(exactResponse({ byName: [projectNode()] }))
    rawRequestGlobex.mockResolvedValueOnce(
      exactResponse({ byName: [projectNode({ id: 'project-2' })] })
    )

    await expect(resolve('Launch')).rejects.toMatchObject({
      code: 'linear_invalid_project',
      data: {
        projects: [
          { id: 'project-1', workspace: { id: 'workspace-acme', name: 'Acme' } },
          { id: 'project-2', workspace: { id: 'workspace-globex', name: 'Globex' } }
        ],
        nextSteps: [
          'Retry with --workspace <id> and the project id.',
          'Run `orca linear project list --query <name> --json` and retry by id.'
        ]
      }
    })
  })

  it('fails closed when one workspace lookup fails even though another matched', async () => {
    rawRequestAcme.mockResolvedValueOnce(exactResponse({ byName: [projectNode()] }))
    rawRequestGlobex.mockRejectedValueOnce(new Error('fetch failed'))

    await expect(resolve('Launch')).rejects.toMatchObject({ code: 'linear_network_error' })
  })

  it('fails closed when a workspace credential cannot be read', async () => {
    getClients.mockImplementation((selection?: string) => {
      if (selection === 'workspace-globex') {
        throw new Error('Linear credentials could not be decrypted')
      }
      return [acme]
    })

    await expect(resolve('Launch')).rejects.toMatchObject({ code: 'linear_network_error' })
    expect(rawRequestAcme).not.toHaveBeenCalled()
  })

  it('confines every read to an explicit workspace', async () => {
    rawRequestGlobex.mockResolvedValueOnce(
      exactResponse({ byName: [projectNode({ id: 'project-2' })] })
    )

    const resolved = await resolve('Launch', 'workspace-globex')

    expect(resolved.workspaceId).toBe('workspace-globex')
    expect(getClients).toHaveBeenCalledWith('workspace-globex')
    expect(rawRequestAcme).not.toHaveBeenCalled()
  })

  it('rejects an unknown explicit workspace', async () => {
    await expect(resolve('Launch', 'workspace-nope')).rejects.toMatchObject({
      code: 'linear_invalid_workspace'
    })
    expect(rawRequestAcme).not.toHaveBeenCalled()
  })

  it('rejects the all selection for a single project target', async () => {
    await expect(resolve('Launch', 'all')).rejects.toMatchObject({
      code: 'linear_invalid_workspace'
    })
  })

  it('rejects an empty target', async () => {
    await expect(resolve('   ')).rejects.toMatchObject({ code: 'linear_invalid_project' })
  })

  it('resolves a Linear URL through its workspace and ignores trailing view segments', async () => {
    rawRequestAcme.mockResolvedValueOnce(exactResponse({ bySlug: [projectNode()] }))

    const resolved = await resolve('https://linear.app/ACME/project/launch-abc/overview')

    expect(resolved).toMatchObject({ id: 'project-1', resolvedBy: 'url' })
    expect(getClients).toHaveBeenCalledWith('workspace-acme')
    expect(rawRequestAcme.mock.calls[0][1]).toEqual({ term: 'launch-abc' })
    expect(rawRequestGlobex).not.toHaveBeenCalled()
  })

  it('decodes only the project segment of a URL', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      exactResponse({ bySlug: [projectNode({ slugId: 'launch plan' })] })
    )

    await resolve('https://linear.app/acme/project/launch%20plan/updates')

    expect(rawRequestAcme.mock.calls[0][1]).toEqual({ term: 'launch plan' })
  })

  it('fails closed on an unknown URL workspace key', async () => {
    await expect(resolve('https://linear.app/unknown/project/launch-abc')).rejects.toMatchObject({
      code: 'linear_invalid_workspace'
    })
    expect(rawRequestAcme).not.toHaveBeenCalled()
  })

  it('fails when the URL workspace conflicts with an explicit workspace', async () => {
    await expect(
      resolve('https://linear.app/acme/project/launch-abc', 'workspace-globex')
    ).rejects.toMatchObject({ code: 'linear_invalid_workspace' })
    expect(rawRequestAcme).not.toHaveBeenCalled()
  })

  it.each([
    'http://linear.app/acme/project/launch-abc',
    'https://evil.linear.app/acme/project/launch-abc',
    'https://linear.app/acme/issue/ENG-1',
    'https://linear.app/acme/project/',
    'https://linear.app/acme/project/%zz',
    'https://linear.app/acme/project/a%2Fb',
    'https://linear.app/acme/project/a%5Cb',
    'linear.app/acme/project/launch-abc'
  ])('rejects the unusable project URL %s', async (input) => {
    await expect(resolve(input)).rejects.toMatchObject({ code: 'linear_invalid_project' })
    expect(rawRequestAcme).not.toHaveBeenCalled()
  })

  it('reports scoped candidates without a uniqueness verdict for create resolution', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      exactResponse({
        bySlug: [projectNode()],
        byName: [projectNode({ id: 'project-2', name: 'launch' })]
      })
    )
    const { findLinearProjectTargetCandidates } = await import('./project-target-resolution')

    const result = await findLinearProjectTargetCandidates('launch', 'workspace-acme')

    expect(result.candidates.map((candidate) => candidate.id)).toEqual(['project-1', 'project-2'])
    expect(result.candidates[0].teams).toEqual([{ id: 'team-1', name: 'Core', key: 'CORE' }])
    expect([...result.slugMatchIds]).toEqual(['project-1'])
    expect(result.ambiguous).toBe(false)
  })
})
