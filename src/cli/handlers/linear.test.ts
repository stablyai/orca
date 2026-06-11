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
