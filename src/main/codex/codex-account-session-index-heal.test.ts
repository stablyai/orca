import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _internals,
  createCodexAccountStateDb,
  healCodexAccountSessionIndex
} from './codex-account-session-index-heal'
import {
  CodexAppServerUnsupportedError,
  type CodexAppServerInvocation,
  type CodexAppServerRpc
} from './codex-app-server-session'

const HOME = '/codex-accounts/account-1/home'

function buildInvocation(): CodexAppServerInvocation {
  return { command: 'codex', args: ['app-server'], cliPath: 'codex', timeoutMs: 1_000 }
}

/** Runs the heal body against a fake app-server that answers thread/read. */
function fakeAppServer(onRead: (threadId: string) => void = () => {}) {
  const readThreadIds: string[] = []
  const runSession = vi.fn(
    async (
      _invocation: CodexAppServerInvocation,
      body: (rpc: CodexAppServerRpc) => Promise<void>
    ): Promise<void> => {
      await body({
        request: async (method, params) => {
          expect(method).toBe('thread/read')
          const threadId = String(params?.threadId)
          readThreadIds.push(threadId)
          onRead(threadId)
          return {}
        },
        notify: () => {}
      })
    }
  )
  return { runSession, readThreadIds }
}

beforeEach(() => {
  _internals.resetFailedThreads()
})

describe('healCodexAccountSessionIndex', () => {
  it('reads only bridged threads missing from the Codex index', async () => {
    const { runSession, readThreadIds } = fakeAppServer()

    const summary = await healCodexAccountSessionIndex(HOME, new Set(['a', 'b', 'c']), {
      readIndexedThreadIds: () => new Set(['b']),
      buildInvocation,
      runSession
    })

    expect(readThreadIds.sort()).toEqual(['a', 'c'])
    expect(summary).toEqual({ outcome: 'completed', healedThreads: 2, failedThreads: 0 })
  })

  it('does not start Codex when every bridged thread is already indexed', async () => {
    const { runSession } = fakeAppServer()

    const summary = await healCodexAccountSessionIndex(HOME, new Set(['a']), {
      readIndexedThreadIds: () => new Set(['a']),
      buildInvocation,
      runSession
    })

    expect(summary.outcome).toBe('up-to-date')
    expect(runSession).not.toHaveBeenCalled()
  })

  it('does not start Codex when its index cannot be read', async () => {
    const { runSession } = fakeAppServer()

    const summary = await healCodexAccountSessionIndex(HOME, new Set(['a']), {
      readIndexedThreadIds: () => null,
      buildInvocation,
      runSession
    })

    expect(summary.outcome).toBe('unreadable')
    expect(runSession).not.toHaveBeenCalled()
  })

  it('stops retrying a thread Codex refuses to index until Orca restarts', async () => {
    const { runSession, readThreadIds } = fakeAppServer((threadId) => {
      if (threadId === 'broken') {
        throw new Error('codex app-server thread/read failed: invalid rollout')
      }
    })
    const dependencies = {
      readIndexedThreadIds: () => new Set<string>(),
      buildInvocation,
      runSession
    }

    const first = await healCodexAccountSessionIndex(HOME, new Set(['broken']), dependencies)
    const second = await healCodexAccountSessionIndex(HOME, new Set(['broken']), dependencies)

    expect(first).toEqual({ outcome: 'completed', healedThreads: 0, failedThreads: 1 })
    expect(second.outcome).toBe('up-to-date')
    expect(readThreadIds).toEqual(['broken'])
  })

  it('retries a thread on the next pass when the app-server session fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('codex app-server exited before responding')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const readIndexedThreadIds = (): Set<string> => new Set()

    const first = await healCodexAccountSessionIndex(HOME, new Set(['a']), {
      readIndexedThreadIds,
      buildInvocation,
      runSession: failing
    })
    const { runSession, readThreadIds } = fakeAppServer()
    const second = await healCodexAccountSessionIndex(HOME, new Set(['a']), {
      readIndexedThreadIds,
      buildInvocation,
      runSession
    })

    expect(first.outcome).toBe('aborted')
    expect(second.outcome).toBe('completed')
    expect(readThreadIds).toEqual(['a'])
    warn.mockRestore()
  })

  it('aborts rather than writing off a thread while a live Codex holds the database', async () => {
    const { runSession } = fakeAppServer(() => {
      throw new Error('codex app-server thread/read failed: database is locked')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = await healCodexAccountSessionIndex(HOME, new Set(['a']), {
      readIndexedThreadIds: () => new Set(),
      buildInvocation,
      runSession
    })

    expect(summary).toEqual({ outcome: 'aborted', healedThreads: 0, failedThreads: 0 })
    warn.mockRestore()
  })
})

describe('createCodexAccountStateDb', () => {
  it('starts Codex on the home without sending any request', async () => {
    const { runSession, readThreadIds } = fakeAppServer()
    const invocations: string[] = []

    const created = await createCodexAccountStateDb(HOME, {
      buildInvocation: (home, timeoutMs) => {
        invocations.push(home)
        return { ...buildInvocation(), timeoutMs }
      },
      runSession
    })

    expect(created).toBe(true)
    expect(invocations).toEqual([HOME])
    expect(readThreadIds).toEqual([])
  })

  it('treats a Codex without app-server as having no state DB to stall', async () => {
    const created = await createCodexAccountStateDb(HOME, {
      buildInvocation,
      runSession: async () => {
        throw new CodexAppServerUnsupportedError('unknown subcommand app-server')
      }
    })

    expect(created).toBe(true)
  })

  it('reports failure when Codex could not start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const created = await createCodexAccountStateDb(HOME, {
      buildInvocation,
      runSession: async () => {
        throw new Error('spawn codex ENOENT')
      }
    })

    expect(created).toBe(false)
    warn.mockRestore()
  })
})
