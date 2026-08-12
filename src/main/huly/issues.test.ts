import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HulyExecFn } from './huly-cli'
import {
  addComment,
  createIssue,
  getIssue,
  listComments,
  listIssues,
  searchIssues,
  updateIssue
} from './issues'
import { acquire, release } from './client'

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
    runHulyCli: async (
      _connection: unknown,
      _password: unknown,
      _token: unknown,
      cliArgs: unknown,
      _options: unknown
    ) => {
      if (!mocks.exec) {
        throw new Error('exec not initialized')
      }
      // Why: mirror the production runHulyCli — parse stdout JSON and propagate
      // rejection so callers get the typed payload they expect.
      const fullArgs = ['--json', '--ci', ...(cliArgs as string[])]
      const result = await mocks.exec('huly', fullArgs, { env: {} })
      return JSON.parse(result.stdout) as never
    }
  }
})

const connection = {
  id: 'huly-1',
  name: 'Test',
  url: 'https://huly.app',
  workspace: 'main',
  email: null
}

const sampleIssue = {
  id: 'CORE-1',
  identifier: 'CORE-1',
  title: 'Auth refactor',
  url: 'https://huly.app/CORE-1',
  state: { id: 's1', name: 'Todo', type: 'open' },
  team: { id: 'team-1', name: 'Core', key: 'CORE' },
  labels: ['bug'],
  labelIds: ['lbl-1'],
  priority: 2,
  updatedAt: '2026-01-01T00:00:00.000Z'
}

beforeEach(() => {
  mocks.exec = vi.fn() as unknown as HulyExecFn & ReturnType<typeof vi.fn>
})

describe('listIssues', () => {
  it('returns issues when the CLI returns valid rows', async () => {
    mocks.exec!.mockResolvedValueOnce({ stdout: JSON.stringify([sampleIssue]), stderr: '' })
    const result = await listIssues('all', 50, 'huly-1')
    expect(result).toHaveLength(1)
    expect(result[0].identifier).toBe('CORE-1')
    expect(result[0].connectionId).toBe('huly-1')
    expect(result[0].state.name).toBe('Todo')
    expect(acquire).toHaveBeenCalled()
    expect(release).toHaveBeenCalled()
  })

  it('passes --assigned when the filter is assigned', async () => {
    mocks.exec!.mockResolvedValueOnce({ stdout: JSON.stringify([sampleIssue]), stderr: '' })
    await listIssues('assigned', 10, 'huly-1')
    const execArgs = (mocks.exec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    // Why: production builds args as ['issue','list','--limit',N,'--assigned'];
    // the --limit comes first to keep the contract predictable.
    expect(execArgs[1]).toEqual(['--json', '--ci', 'issue', 'list', '--limit', '10', '--assigned'])
  })

  it('drops rows missing required fields', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify([sampleIssue, { id: 'no-id' }]),
      stderr: ''
    })
    const result = await listIssues('all', 50, 'huly-1')
    expect(result).toHaveLength(1)
  })
})

describe('getIssue', () => {
  it('returns a single parsed issue', async () => {
    mocks.exec!.mockResolvedValueOnce({ stdout: JSON.stringify(sampleIssue), stderr: '' })
    const result = await getIssue('CORE-1', 'huly-1')
    expect(result?.identifier).toBe('CORE-1')
  })

  it('returns null when the CLI payload is invalid', async () => {
    mocks.exec!.mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'x' }), stderr: '' })
    const result = await getIssue('CORE-1', 'huly-1')
    expect(result).toBeNull()
  })
})

describe('searchIssues', () => {
  it('forwards the query and limit to huly issue list', async () => {
    mocks.exec!.mockResolvedValueOnce({ stdout: JSON.stringify([sampleIssue]), stderr: '' })
    await searchIssues('login', 25, 'huly-1')
    const execArgs = (mocks.exec as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    expect(execArgs[1]).toEqual([
      '--json',
      '--ci',
      'issue',
      'list',
      '--query',
      'login',
      '--limit',
      '25'
    ])
  })
})

describe('createIssue', () => {
  it('returns ok with parsed issue on success', async () => {
    mocks.exec!.mockResolvedValueOnce({ stdout: JSON.stringify(sampleIssue), stderr: '' })
    const result = await createIssue(
      { teamId: 'team-1', title: 'Auth refactor', priority: 2, labelIds: ['lbl-1'] },
      'huly-1'
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.issue.identifier).toBe('CORE-1')
    }
  })

  it('returns ok false with error message on failure', async () => {
    mocks.exec!.mockRejectedValueOnce(new Error('boom'))
    const result = await createIssue({ teamId: 'team-1', title: 'Auth refactor' }, 'huly-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('boom')
    }
  })
})

describe('updateIssue', () => {
  it('returns ok on success', async () => {
    mocks.exec!.mockResolvedValueOnce({ stdout: '{}', stderr: '' })
    const result = await updateIssue('CORE-1', { title: 'New title', priority: 1 }, 'huly-1')
    expect(result.ok).toBe(true)
  })

  it('returns ok false on failure', async () => {
    mocks.exec!.mockRejectedValueOnce(new Error('permission denied'))
    const result = await updateIssue('CORE-1', { title: 'X' }, 'huly-1')
    expect(result.ok).toBe(false)
  })
})

describe('addComment', () => {
  it('returns ok with parsed comment on success', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify({ id: 'c-1', body: 'nice', createdAt: '2026-01-01T00:00:00.000Z' }),
      stderr: ''
    })
    const result = await addComment('CORE-1', 'nice', 'huly-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.comment.id).toBe('c-1')
    }
  })

  it('returns ok false on failure', async () => {
    mocks.exec!.mockRejectedValueOnce(new Error('boom'))
    const result = await addComment('CORE-1', 'x', 'huly-1')
    expect(result.ok).toBe(false)
  })
})

describe('listComments', () => {
  it('returns parsed comments on success', async () => {
    mocks.exec!.mockResolvedValueOnce({
      stdout: JSON.stringify([{ id: 'c-1', body: 'a', createdAt: '2026-01-01T00:00:00.000Z' }]),
      stderr: ''
    })
    const result = await listComments('CORE-1', 'huly-1')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c-1')
  })

  it('propagates errors from the CLI instead of swallowing them', async () => {
    mocks.exec!.mockRejectedValueOnce(new Error('boom'))
    await expect(listComments('CORE-1', 'huly-1')).rejects.toThrow('boom')
  })
})

// Why: tests run a beforeEach to reset the mock and import `connection` for
// the unread-keypath check that vi.hoisted ordering stays intact.
void connection
