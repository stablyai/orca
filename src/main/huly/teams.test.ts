import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HulyExecFn } from './huly-cli'
import { listTeams, getTeamMembers, getTeamStates, getTeamLabels } from './teams'

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

beforeEach(() => {
  mocks.exec = vi.fn() as unknown as HulyExecFn & ReturnType<typeof vi.fn>
})

describe('listTeams', () => {
  it('returns parsed teams', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { id: 'team-1', name: 'Core', key: 'CORE' },
        { id: 'team-2', name: 'Ops', key: 'OPS' }
      ]),
      stderr: ''
    })
    const result = await listTeams('huly-1')
    expect(result).toHaveLength(2)
    expect(result[0].key).toBe('CORE')
  })

  it('returns empty array when no connection is configured', async () => {
    const client = await import('./client')
    vi.mocked(client.getConnection).mockReturnValueOnce(null)
    const result = await listTeams('huly-1')
    expect(result).toEqual([])
  })
})

describe('getTeamMembers', () => {
  it('returns parsed members', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify([{ id: 'u-1', displayName: 'Alice' }]),
      stderr: ''
    })
    const result = await getTeamMembers('team-1', 'huly-1')
    expect(result).toHaveLength(1)
    expect(result[0].displayName).toBe('Alice')
  })

  it('returns empty array on no connection', async () => {
    const client = await import('./client')
    vi.mocked(client.getConnection).mockReturnValueOnce(null)
    const result = await getTeamMembers('team-1', 'huly-1')
    expect(result).toEqual([])
  })
})

describe('getTeamStates', () => {
  it('returns parsed states', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify([{ id: 's-1', name: 'Todo', type: 'open' }]),
      stderr: ''
    })
    const result = await getTeamStates('team-1', 'huly-1')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('open')
  })
})

describe('getTeamLabels', () => {
  it('returns parsed labels', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify([{ id: 'l-1', name: 'bug' }]),
      stderr: ''
    })
    const result = await getTeamLabels('team-1', 'huly-1')
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('bug')
  })
})
