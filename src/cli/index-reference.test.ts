import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { buildWorktree, okFixture } from './test-fixtures'
import {
  getWorkspaceReferenceIdentity,
  parseWorkspaceReferenceUrl
} from '../shared/workspace-reference-identity'
import { WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY } from '../shared/workspace-attachment-capabilities'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const PR = 'https://github.com/acme/api/pull/5123'
const TASK = 'https://linear.app/acme/issue/STA-1234'
const parsedPR = parseWorkspaceReferenceUrl(PR)
const parsedTask = parseWorkspaceReferenceUrl(TASK)

function listResult(references = [parsedPR], kind: 'worktree' | 'folder' = 'worktree') {
  return {
    worktree: {
      ...buildWorktree('/tmp/api', 'api'),
      id: kind === 'folder' ? 'folder:folder1' : 'repo::/tmp/api',
      name: 'api',
      kind,
      repo: 'repo'
    },
    references: references.map((item) => ({
      ...item,
      key: getWorkspaceReferenceIdentity(item),
      selected: true
    }))
  }
}

function mockCalls(
  before = listResult(),
  after = before,
  capabilities = [WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY]
) {
  let lists = 0
  callMock.mockImplementation(async (method: string) => {
    if (method === 'status.get') {
      return okFixture('status', { capabilities })
    }
    if (method === 'reference.list') {
      return okFixture('list', lists++ === 0 ? before : after)
    }
    if (method === 'reference.find') {
      return okFixture('find', { kind: 'reference_matches', matches: [], truncated: false })
    }
    return okFixture('mutation', { worktree: before.worktree })
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('reference CLI', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('adds several URLs through the existing delta merge and never invents origins', async () => {
    mockCalls(listResult([]), listResult([parsedPR, parsedTask]))
    await main(['reference', 'add', PR, TASK, '--worktree', 'name:api', '--json'], '/tmp/api')
    expect(callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/api',
      linkedItemsBase: [],
      linkedItems: [parsedPR, parsedTask],
      linkedItemsSelectionChanged: false
    })
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).result.changes).toHaveLength(2)
  })

  it('validates every URL before any request', async () => {
    mockCalls()
    await main(['reference', 'add', PR, 'github:pr:4', '--worktree', 'name:api'], '/tmp/api')
    expect(callMock).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalled()
  })

  it('requires the delta capability even if the host supports linked items', async () => {
    mockCalls(listResult(), listResult(), ['worktree.linked-items.v1'])
    await main(['reference', 'add', TASK, '--worktree', 'name:api'], '/tmp/api')
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('cannot merge'))
  })

  it('duplicate adds preserve current metadata and produce a no-op', async () => {
    mockCalls()
    await main(['reference', 'add', PR, PR, '--worktree', 'name:api', '--json'], '/tmp/api')
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.set')).toBe(false)
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).result.changes).toEqual([
      {
        key: getWorkspaceReferenceIdentity(parsedPR),
        operation: 'add',
        changed: false,
        reason: 'already_linked'
      }
    ])
  })

  it('removes only requested keys from folders via existing folder storage', async () => {
    mockCalls(listResult([parsedPR, parsedTask], 'folder'), listResult([parsedTask], 'folder'))
    await main(
      [
        'reference',
        'remove',
        '--key',
        getWorkspaceReferenceIdentity(parsedPR),
        '--worktree',
        'folder:folder1'
      ],
      '/tmp/api'
    )
    expect(callMock).toHaveBeenCalledWith('folderWorkspace.update', {
      folderWorkspaceId: 'folder1',
      updates: {
        linkedItemsBase: [parsedPR, parsedTask],
        linkedItems: [parsedTask],
        linkedItemsSelectionChanged: false
      }
    })
  })

  it('removes a URL without touching the same review number in another repository', async () => {
    const other = parseWorkspaceReferenceUrl('https://github.com/acme/other/pull/5123')
    mockCalls(listResult([parsedPR, other]), listResult([other]))
    await main(['reference', 'remove', PR, '--worktree', 'name:api'], '/tmp/api')
    expect(callMock).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({ linkedItemsBase: [parsedPR, other], linkedItems: [other] })
    )
  })

  const localTwin = {
    ...parsedPR,
    title: 'Local',
    taskSourceContext: {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: 'p1',
      hostId: 'local' as const
    }
  }
  const remoteTwin = {
    ...parsedPR,
    title: 'Remote',
    taskSourceContext: {
      ...localTwin.taskSourceContext,
      hostId: 'runtime:other' as const
    }
  }

  it('keeps same-URL twins with different source contexts on an unrelated add', async () => {
    mockCalls(listResult([localTwin, remoteTwin]))
    await main(['reference', 'add', TASK, '--worktree', 'name:api'], '/tmp/api')
    expect(callMock).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({
        linkedItemsBase: [localTwin, remoteTwin],
        linkedItems: [localTwin, remoteTwin, parsedTask]
      })
    )
  })

  it('removing a URL removes every twin that shares its identity', async () => {
    mockCalls(listResult([localTwin, parsedTask, remoteTwin]), listResult([parsedTask]))
    await main(['reference', 'remove', PR, '--worktree', 'name:api'], '/tmp/api')
    expect(callMock).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({
        linkedItemsBase: [localTwin, parsedTask, remoteTwin],
        linkedItems: [parsedTask]
      })
    )
  })

  it('removes by the host-provided key even when the local identity differs', async () => {
    const before = listResult([parsedPR, parsedTask])
    before.references[0].key = 'host-v2:pr-key'
    mockCalls(before, listResult([parsedTask]))
    await main(
      ['reference', 'remove', '--key', 'host-v2:pr-key', '--worktree', 'name:api', '--json'],
      '/tmp/api'
    )
    expect(callMock).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({
        linkedItemsBase: [parsedPR, parsedTask],
        linkedItems: [parsedTask]
      })
    )
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).result.changes).toEqual([
      { key: 'host-v2:pr-key', operation: 'remove', changed: true }
    ])
  })

  it('removing an absent URL is a no-op', async () => {
    mockCalls()
    await main(['reference', 'remove', TASK, '--worktree', 'name:api', '--json'], '/tmp/api')
    expect(callMock.mock.calls.some(([method]) => method === 'worktree.set')).toBe(false)
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).result.changes[0]).toMatchObject({
      changed: false,
      reason: 'not_linked'
    })
  })

  it('rejects remote current without resolving the local cwd on the paired host', async () => {
    mockCalls()
    await main(
      ['reference', 'find', 'STA-1234', '--worktree', 'current', '--pairing-code', 'remote'],
      '/tmp/api'
    )
    expect(callMock).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('remote host'))
  })

  it('forwards local caller path context so WSL selectors resolve without a scan', async () => {
    mockCalls()
    const cwd = String.raw`\\wsl$\Ubuntu\home\me\repo`
    await main(['reference', 'find', 'STA-1234', '--worktree', 'path:/home/me/repo'], cwd)
    expect(callMock).toHaveBeenCalledExactlyOnceWith(
      'reference.find',
      expect.objectContaining({ worktree: 'path:/home/me/repo', cwd })
    )
  })

  it('passes explicit paired-host selectors unchanged', async () => {
    mockCalls()
    await main(
      ['reference', 'find', 'STA-1234', '--worktree', 'path:/srv/api', '--pairing-code', 'remote'],
      '/tmp/api'
    )
    expect(callMock).toHaveBeenCalledExactlyOnceWith(
      'reference.find',
      expect.objectContaining({ worktree: 'path:/srv/api' })
    )
    expect(callMock.mock.calls[0][1]).not.toHaveProperty('cwd')
  })

  it('uses metadata current lookup instead of worktree.list or Git scanning', async () => {
    mockCalls()
    await main(
      [
        'reference',
        'find',
        'STA-1234',
        '--worktree',
        'current',
        '--include-archived',
        '--limit',
        '10'
      ],
      '/tmp/api/subdir'
    )
    expect(callMock).toHaveBeenCalledExactlyOnceWith('reference.find', {
      query: 'STA-1234',
      worktree: 'current',
      cwd: '/tmp/api/subdir',
      repo: undefined,
      includeArchived: true,
      limit: 10
    })
  })

  it.each([
    ['5123'],
    ['STA-1234', '--worktree', 'name:api', '--repo', 'id:repo'],
    ['STA-1234', '--limit', '0']
  ])('rejects invalid find arguments %j before querying', async (...args) => {
    mockCalls()
    await main(['reference', 'find', ...args], '/tmp/api')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('seeds repeated references in the create request before setup or agent startup', async () => {
    mockCalls()
    await main(
      [
        'worktree',
        'create',
        '--name',
        'fix',
        '--repo',
        'id:repo',
        '--no-parent',
        '--reference',
        PR,
        '--reference',
        TASK
      ],
      '/tmp/api'
    )
    expect(callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ linkedItems: [parsedPR, parsedTask] })
    )
  })

  it.each(['pr', 'issue', 'linear-issue', 'gitlab-issue', 'gitlab-mr'])(
    'rejects create --reference mixed with --%s',
    async (flag) => {
      mockCalls()
      await main(
        [
          'worktree',
          'create',
          '--name',
          'fix',
          '--repo',
          'id:repo',
          '--no-parent',
          '--reference',
          PR,
          `--${flag}`,
          '4'
        ],
        '/tmp/api'
      )
      expect(callMock).not.toHaveBeenCalled()
    }
  )

  // Why: hosts built before reference.* still advertise the delta capability.
  it.each([
    [['reference', 'list', '--worktree', 'name:api']],
    [['reference', 'find', '--query', 'STA-1234']],
    [['reference', 'add', TASK, '--worktree', 'name:api']]
  ])('names the version gap when the host lacks reference RPCs: %j', async (argv) => {
    mockCalls()
    const { RuntimeClientError } = await import('./runtime/types.js')
    const base = callMock.getMockImplementation()
    callMock.mockImplementation(async (method: string, ...rest: unknown[]) => {
      if (method.startsWith('reference.')) {
        throw new RuntimeClientError('method_not_found', `Unknown method: ${method}`)
      }
      return base?.(method, ...rest)
    })
    const priorExitCode = process.exitCode
    await main(argv, '/tmp/api')
    const printed = vi.mocked(console.error).mock.calls.flat().join('\n')
    expect(printed).toContain('Update Orca on the execution host')
    expect(printed).not.toContain('Unknown method')
    expect(process.exitCode).toBe(1)
    process.exitCode = priorExitCode
  })

  it('validates create flags locally before probing reference capability', async () => {
    mockCalls()
    await main(
      ['worktree', 'create', '--repo', 'id:repo', '--no-parent', '--reference', PR],
      '/tmp/api'
    )
    expect(callMock).not.toHaveBeenCalledWith('status.get', expect.anything())
    expect(callMock).not.toHaveBeenCalledWith('status.get')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--name'))
  })
})
