import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode = process.env.ORCA_PAIRING_CODE ?? null,
      environmentSelector = process.env.ORCA_ENVIRONMENT ?? null
    ) {
      this.isRemote = Boolean(remotePairingCode || environmentSelector)
    }
  }

  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeRpcFailureError extends RuntimeClientError {
    readonly response: unknown

    constructor(response: unknown) {
      super('runtime_error', 'runtime_error')
      this.response = response
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

describe('orca linear CLI handlers', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.env = { ...originalEnv }
    // Why: these tests can run inside an Orca-managed terminal, which exports
    // real worktree/terminal/pairing env hints; clear them so handler context
    // assertions stay deterministic.
    delete process.env.ORCA_WORKTREE_ID
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PAIRING_CODE
    delete process.env.ORCA_ENVIRONMENT
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('maps --full issue reads to read-only issueContext RPC', async () => {
    queueFixtures(callMock, okFixture('req_linear', issueResult()))

    await main(['linear', 'issue', 'ENG-123', '--full', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'linear.issueContext',
      {
        input: 'ENG-123',
        current: false,
        workspaceId: undefined,
        include: {
          comments: true,
          children: true,
          attachments: true,
          relations: true
        },
        depth: 2,
        context: {
          remote: false,
          cwd: '/tmp/repo'
        }
      },
      { timeoutMs: 120_000 }
    )
  })

  it('keeps global boolean flags before Linear commands from consuming command tokens', async () => {
    queueFixtures(callMock, okFixture('req_linear', issueResult()))

    await main(['--json', 'linear', 'issue', 'ENG-123', '--full'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'linear.issueContext',
      expect.objectContaining({
        input: 'ENG-123',
        include: expect.objectContaining({
          comments: true,
          children: true,
          attachments: true,
          relations: true
        })
      }),
      { timeoutMs: 120_000 }
    )
  })

  it('passes verified current-context hints without resolving cwd for remote runtimes', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_123'
    process.env.ORCA_WORKTREE_ID = 'repo::/srv/app'
    process.env.ORCA_PAIRING_CODE = 'orca://pair?payload=bad'
    queueFixtures(callMock, okFixture('req_linear', issueResult()))

    await main(['linear', 'issue', '--current', '--comments', '--json'], '/client/repo')

    expect(callMock).toHaveBeenCalledWith(
      'linear.issueContext',
      expect.objectContaining({
        input: undefined,
        current: true,
        include: expect.objectContaining({ comments: true }),
        context: {
          remote: true,
          worktreeId: 'repo::/srv/app',
          terminalHandle: 'term_123'
        }
      }),
      { timeoutMs: undefined }
    )
  })

  it('rejects --depth unless children are requested', async () => {
    await main(['linear', 'issue', 'ENG-123', '--depth', '3'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      '--depth requires --children or --full'
    )
    expect(process.exitCode).toBe(1)
  })

  it('maps search to agent search RPC with capped limit', async () => {
    queueFixtures(
      callMock,
      okFixture('req_search', {
        issues: [],
        meta: { query: 'auth', workspaceId: 'all', limit: 50, returned: 0, limitReached: false }
      })
    )

    await main(['linear', 'search', 'auth', '--workspace', 'all', '--limit', '500'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('linear.agentSearchIssues', {
      query: 'auth',
      limit: 50,
      workspaceId: 'all'
    })
  })

  it('maps project list to agent project RPC with capped limit', async () => {
    queueFixtures(
      callMock,
      okFixture('req_projects', {
        projects: [],
        meta: {
          query: 'launch',
          workspaceId: 'all',
          limit: 50,
          returned: 0,
          hasMore: false,
          partial: false,
          workspaceErrors: []
        }
      })
    )

    await main(
      ['linear', 'project', 'list', '--query', 'launch', '--workspace', 'all', '--limit', '500'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('linear.agentProjectList', {
      query: 'launch',
      limit: 50,
      workspaceId: 'all'
    })
  })

  it('keeps boolean flags between Linear and search from consuming the subcommand', async () => {
    queueFixtures(
      callMock,
      okFixture('req_search', {
        issues: [],
        meta: { query: 'auth', workspaceId: undefined, limit: 1, returned: 0, limitReached: false }
      })
    )

    await main(['linear', '--json', 'search', 'auth', '--limit', '1'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('linear.agentSearchIssues', {
      query: 'auth',
      limit: 1,
      workspaceId: undefined
    })
  })

  it('maps status writes to the agent write RPC with an explicit target', async () => {
    queueFixtures(callMock, okFixture('req_status', statusSetResult()))

    await main(['linear', 'status', 'set', 'ENG-123', '--to', 'In Review', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'linear.issueSetState',
      {
        input: 'ENG-123',
        current: false,
        workspaceId: undefined,
        to: 'In Review',
        context: {
          remote: false,
          cwd: '/tmp/repo'
        }
      },
      { timeoutMs: 75_000 }
    )
  })

  it('maps priority writes with Linear API priority numbering', async () => {
    queueFixtures(callMock, okFixture('req_priority', taskUpdateResult('priority')))

    await main(['linear', 'priority', 'set', 'ENG-123', '--to', 'urgent', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'linear.issueUpdateTask',
      expect.objectContaining({
        input: 'ENG-123',
        operation: 'priority',
        priority: 1
      }),
      { timeoutMs: 75_000 }
    )
  })

  it('rejects impossible due dates before dispatch', async () => {
    await main(['linear', 'due-date', 'set', 'ENG-123', '--to', '2026-02-30'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('real calendar date')
  })

  it('preserves repeated labels for label updates', async () => {
    queueFixtures(callMock, okFixture('req_label', taskUpdateResult('labels')))

    await main(
      ['linear', 'label', 'add', 'ENG-123', '--label', 'Bug', '--label', 'Regression', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'linear.issueUpdateTask',
      expect.objectContaining({
        input: 'ENG-123',
        operation: 'labels',
        labelMode: 'add',
        labels: ['Bug', 'Regression']
      }),
      { timeoutMs: 75_000 }
    )
  })

  it('requires exact write targets for issue writes', async () => {
    await main(['linear', 'comment', 'add', '--body', 'done'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      'Pass a Linear issue id or --current'
    )
    expect(process.exitCode).toBe(1)
  })

  it('rejects --workspace all for writes before dispatch', async () => {
    await main(
      [
        'linear',
        'attach',
        'ENG-123',
        '--url',
        'https://example.com/review/123',
        '--workspace',
        'all'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain(
      '--workspace all is not valid for Linear writes'
    )
    expect(process.exitCode).toBe(1)
  })

  it('reads comment bodies from stdin and passes retry write ids through', async () => {
    const stdin = mockStdin(false, ['line one\n', 'line two'])
    queueFixtures(callMock, okFixture('req_comment', commentAddResult()))

    try {
      await main(
        [
          'linear',
          'comment',
          'add',
          '--current',
          '--body-file',
          '-',
          '--reply-to',
          'comment-parent',
          '--write-id',
          '123e4567-e89b-12d3-a456-426614174000',
          '--json'
        ],
        '/tmp/repo'
      )
    } finally {
      stdin.restore()
    }

    expect(callMock).toHaveBeenCalledWith(
      'linear.issueAddComment',
      {
        input: undefined,
        current: true,
        workspaceId: undefined,
        body: 'line one\nline two',
        replyTo: 'comment-parent',
        writeId: '123e4567-e89b-12d3-a456-426614174000',
        context: {
          remote: false,
          cwd: '/tmp/repo'
        }
      },
      { timeoutMs: 75_000 }
    )
  })

  it('rejects malformed write ids before dispatch', async () => {
    await main(
      [
        'linear',
        'attach',
        'ENG-123',
        '--url',
        'https://example.com/review/123',
        '--write-id',
        'not-a-uuid',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    const payload = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0])) as {
      error: { code: string }
    }
    expect(payload.error.code).toBe('linear_invalid_write_id')
  })

  it('maps create with parent-current and optional body flags', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult()))

    await main(
      [
        'linear',
        'create',
        '--title',
        'Follow-up bug',
        '--body',
        'Concrete repro',
        '--parent-current',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'linear.issueCreate',
      {
        title: 'Follow-up bug',
        body: 'Concrete repro',
        teamInput: undefined,
        state: undefined,
        assignee: undefined,
        priority: undefined,
        estimate: undefined,
        dueDate: undefined,
        labels: [],
        parentInput: undefined,
        parentCurrent: true,
        workspaceId: undefined,
        writeId: undefined,
        context: {
          remote: false,
          cwd: '/tmp/repo'
        }
      },
      { timeoutMs: 75_000 }
    )
  })

  it('maps enriched create task fields', async () => {
    queueFixtures(callMock, okFixture('req_create', createResult()))

    await main(
      [
        'linear',
        'create',
        '--title',
        'Triage bug',
        '--team',
        'ENG',
        '--project',
        'project-1',
        '--state',
        'Todo',
        '--assignee',
        'me',
        '--priority',
        'high',
        '--estimate',
        '2',
        '--due-date',
        '2026-06-30',
        '--label',
        'Bug',
        '--label',
        'Regression',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'linear.issueCreate',
      expect.objectContaining({
        title: 'Triage bug',
        teamInput: 'ENG',
        projectInput: 'project-1',
        state: 'Todo',
        assignee: 'me',
        priority: 2,
        estimate: 2,
        dueDate: '2026-06-30',
        labels: ['Bug', 'Regression']
      }),
      { timeoutMs: 75_000 }
    )
  })

  it('rejects duplicate body inputs before dispatch', async () => {
    await main(
      ['linear', 'create', '--title', 'Bug', '--body', 'one', '--body-file', 'body.md'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Use either --body or --body-file')
  })
})

function issueResult(): unknown {
  return {
    issue: {
      id: 'issue-id',
      identifier: 'ENG-123',
      title: 'Fix auth',
      url: 'https://linear.app/acme/issue/ENG-123',
      state: { name: 'Todo' },
      team: { name: 'Engineering' },
      labels: []
    },
    meta: {
      requested: {
        current: false,
        include: { comments: false, children: false, attachments: false, relations: false },
        depth: 2
      },
      resolved: {
        id: 'issue-id',
        identifier: 'ENG-123',
        workspaceId: 'workspace-1',
        workspaceName: 'Acme'
      },
      partial: false,
      includeErrors: [],
      sections: {}
    }
  }
}

function statusSetResult(): unknown {
  return {
    issue: { id: 'issue-id', identifier: 'ENG-123', url: 'https://linear.app/acme/issue/ENG-123' },
    state: { id: 'state-review', name: 'In Review', type: 'started' },
    previousState: { id: 'state-started', name: 'In Progress' },
    meta: { workspaceId: 'workspace-1', alreadyInState: false }
  }
}

function commentAddResult(): unknown {
  return {
    comment: { id: 'comment-id', url: null, parentId: 'comment-parent' },
    issue: { id: 'issue-id', identifier: 'ENG-123', url: 'https://linear.app/acme/issue/ENG-123' },
    meta: {
      workspaceId: 'workspace-1',
      bodyChars: 17,
      writeId: '123e4567-e89b-12d3-a456-426614174000',
      deduplicated: false
    }
  }
}

function createResult(): unknown {
  return {
    issue: {
      id: 'issue-child',
      identifier: 'ENG-456',
      title: 'Follow-up bug',
      url: 'https://linear.app/acme/issue/ENG-456',
      team: { id: 'team-eng', key: 'ENG', name: 'Engineering' },
      state: { id: 'state-triage', name: 'Triage' },
      parent: { id: 'issue-id', identifier: 'ENG-123' }
    },
    meta: {
      workspaceId: 'workspace-1',
      writeId: '123e4567-e89b-12d3-a456-426614174000',
      deduplicated: false
    }
  }
}

function taskUpdateResult(operation: string): unknown {
  return {
    issue: { id: 'issue-id', identifier: 'ENG-123', url: 'https://linear.app/acme/issue/ENG-123' },
    operation,
    previous: {},
    current: {},
    meta: { workspaceId: 'workspace-1', alreadySet: false }
  }
}

function mockStdin(isTTY: boolean, chunks: string[]): { restore: () => void } {
  const stdin = process.stdin
  const previousIsTTY = stdin.isTTY
  const previousAsyncIterator = stdin[Symbol.asyncIterator]
  Object.defineProperty(stdin, 'isTTY', {
    configurable: true,
    value: isTTY
  })
  ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
    return undefined
  }
  return {
    restore: () => {
      Object.defineProperty(stdin, 'isTTY', {
        configurable: true,
        value: previousIsTTY
      })
      if (previousAsyncIterator) {
        ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = previousAsyncIterator
      } else {
        Reflect.deleteProperty(stdin, Symbol.asyncIterator)
      }
    }
  }
}
