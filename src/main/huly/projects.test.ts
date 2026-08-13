import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HulyExecFn } from './huly-cli'
import { listProjects, getProject, createProject, listProjectIssues } from './projects'

const mocks = vi.hoisted(() => ({
  exec: null as null | (HulyExecFn & ReturnType<typeof vi.fn>)
}))

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  getConnection: vi.fn(() => ({
    id: 'huly-1',
    name: 'Test',
    url: 'https://huly.app',
    workspace: 'main',
    email: null
  })),
  getSecret: vi.fn(() => 'token-xyz')
}))

vi.mock('./huly-cli', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    runHulyCli: async (_c: unknown, _p: unknown, _t: unknown, cliArgs: unknown) => {
      if (!mocks.exec) {
        throw new Error('exec not initialized')
      }
      const result = await mocks.exec('huly', ['--json', '--ci', ...(cliArgs as string[])], {
        env: {}
      })
      return JSON.parse(result.stdout) as never
    }
  }
})

vi.mock('./issues', () => ({
  listIssues: vi.fn().mockResolvedValue([
    {
      id: 'CORE-1',
      connectionId: 'huly-1',
      identifier: 'CORE-1',
      title: 'In project A',
      url: 'https://huly.app/CORE-1',
      state: { id: 's1', name: 'Todo', type: 'open' },
      team: { id: 'team-1', name: 'Core', key: 'CORE' },
      project: { id: 'p-a', name: 'Project A' },
      labels: [],
      labelIds: [],
      priority: 0,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'CORE-2',
      connectionId: 'huly-1',
      identifier: 'CORE-2',
      title: 'In project B',
      url: 'https://huly.app/CORE-2',
      state: { id: 's1', name: 'Todo', type: 'open' },
      team: { id: 'team-1', name: 'Core', key: 'CORE' },
      project: { id: 'p-b', name: 'Project B' },
      labels: [],
      labelIds: [],
      priority: 0,
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ])
}))

beforeEach(() => {
  mocks.exec = vi.fn() as unknown as HulyExecFn & ReturnType<typeof vi.fn>
})

describe('listProjects', () => {
  it('returns parsed projects', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify([{ id: 'p-a', name: 'Project A' }]),
      stderr: ''
    })
    const result = await listProjects(undefined, 20, 'huly-1')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Project A')
  })

  it('forwards the query when provided', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify([]),
      stderr: ''
    })
    await listProjects('migration', 20, 'huly-1')
    const execArgs = (mocks.exec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(execArgs[1]).toEqual([
      '--json',
      '--ci',
      'project',
      'list',
      '--limit',
      '20',
      '--query',
      'migration'
    ])
  })

  it('returns empty array when no connection is configured', async () => {
    const client = await import('./client')
    vi.mocked(client.getConnection).mockReturnValueOnce(null)
    const result = await listProjects(undefined, 20, 'huly-1')
    expect(result).toEqual([])
  })
})

describe('getProject', () => {
  it('returns parsed project', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify({ id: 'p-a', name: 'Project A' }),
      stderr: ''
    })
    const result = await getProject('p-a', 'huly-1')
    expect(result?.name).toBe('Project A')
  })

  it('returns null on no connection', async () => {
    const client = await import('./client')
    vi.mocked(client.getConnection).mockReturnValueOnce(null)
    const result = await getProject('p-a', 'huly-1')
    expect(result).toBeNull()
  })
})

describe('createProject', () => {
  it('returns ok with parsed project on success', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify({ id: 'p-new', name: 'New Project' }),
      stderr: ''
    })
    const result = await createProject({ name: 'New Project' }, 'huly-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.project.id).toBe('p-new')
    }
  })

  it('returns ok false with error message on failure', async () => {
    mocks.exec!.mockRejectedValueOnce(new Error('permission denied'))
    const result = await createProject({ name: 'New Project' }, 'huly-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('permission denied')
    }
  })
})

describe('listProjectIssues', () => {
  it('returns only issues whose project matches the requested id', async () => {
    const result = await listProjectIssues('p-a', 50, 'huly-1')
    expect(result).toHaveLength(1)
    expect(result[0].project?.id).toBe('p-a')
  })
})
