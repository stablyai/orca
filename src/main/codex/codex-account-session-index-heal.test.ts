import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

// Why: fails closed if a regression bypasses the fake session — never the real codex or ~/.codex.
function buildInvocation(): CodexAppServerInvocation {
  return {
    command: '/nonexistent/orca-test-codex',
    args: ['app-server'],
    cliPath: null,
    env: { CODEX_HOME: join(tmpdir(), 'orca-test-nonexistent-codex-home') },
    timeoutMs: 1_000
  }
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

/** Bridged threads keyed by id, all from the same rollout timestamp. */
function bridged(...threadIds: string[]): Map<string, string> {
  return new Map(threadIds.map((threadId) => [threadId, '2026-07-20T10-00-00']))
}

beforeEach(() => {
  _internals.resetFailedThreads()
})

describe('healCodexAccountSessionIndex', () => {
  it('reads only bridged threads missing from the Codex index', async () => {
    const { runSession, readThreadIds } = fakeAppServer()

    const summary = await healCodexAccountSessionIndex(HOME, bridged('a', 'b', 'c'), {
      readIndexedThreadIds: () => new Set(['b']),
      buildInvocation,
      runSession
    })

    expect(readThreadIds.sort()).toEqual(['a', 'c'])
    expect(summary).toEqual({
      outcome: 'completed',
      healedThreads: 2,
      missingThreads: 0,
      failedThreads: 0
    })
  })

  it('reads the most recent bridged rollouts first', async () => {
    const { runSession, readThreadIds } = fakeAppServer()

    await healCodexAccountSessionIndex(
      HOME,
      new Map([
        ['middle', '2026-08-01T09-00-00'],
        ['oldest', '2025-12-31T23-59-59'],
        ['newest', '2026-09-28T01-46-16']
      ]),
      { readIndexedThreadIds: () => new Set(), buildInvocation, runSession, readConcurrency: 1 }
    )

    expect(readThreadIds).toEqual(['newest', 'middle', 'oldest'])
  })

  it('does not start Codex when every bridged thread is already indexed', async () => {
    const { runSession } = fakeAppServer()

    const summary = await healCodexAccountSessionIndex(HOME, bridged('a'), {
      readIndexedThreadIds: () => new Set(['a']),
      buildInvocation,
      runSession
    })

    expect(summary.outcome).toBe('up-to-date')
    expect(runSession).not.toHaveBeenCalled()
  })

  it('does not start Codex when its index cannot be read', async () => {
    const { runSession } = fakeAppServer()

    const summary = await healCodexAccountSessionIndex(HOME, bridged('a'), {
      readIndexedThreadIds: () => null,
      buildInvocation,
      runSession
    })

    expect(summary.outcome).toBe('no-index')
    expect(runSession).not.toHaveBeenCalled()
  })

  it('does not start Codex once the app is quitting', async () => {
    const { runSession } = fakeAppServer()

    const summary = await healCodexAccountSessionIndex(HOME, bridged('a'), {
      readIndexedThreadIds: () => new Set(),
      buildInvocation,
      runSession,
      shouldStop: () => true
    })

    expect(summary.outcome).toBe('stopped')
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

    const first = await healCodexAccountSessionIndex(HOME, bridged('broken'), dependencies)
    const second = await healCodexAccountSessionIndex(HOME, bridged('broken'), dependencies)

    expect(first).toEqual({
      outcome: 'completed',
      healedThreads: 0,
      missingThreads: 0,
      failedThreads: 1
    })
    expect(second.outcome).toBe('up-to-date')
    expect(readThreadIds).toEqual(['broken'])
  })

  it('remembers a refused thread only for the home that refused it', async () => {
    const { runSession, readThreadIds } = fakeAppServer((threadId) => {
      if (readThreadIds.length === 1) {
        throw new Error(`codex app-server thread/read failed: invalid rollout ${threadId}`)
      }
    })
    const dependencies = {
      readIndexedThreadIds: () => new Set<string>(),
      buildInvocation,
      runSession
    }

    await healCodexAccountSessionIndex(HOME, bridged('shared'), dependencies)
    const other = await healCodexAccountSessionIndex(
      '/codex-accounts/account-2/home',
      bridged('shared'),
      dependencies
    )

    expect(other.healedThreads).toBe(1)
    expect(readThreadIds).toEqual(['shared', 'shared'])
  })

  it('counts a rollout Codex cannot find as missing and does not reread it', async () => {
    const { runSession, readThreadIds } = fakeAppServer(() => {
      throw new Error('codex app-server thread/read failed: no rollout found for thread id gone')
    })
    const options = { readIndexedThreadIds: () => new Set<string>(), buildInvocation, runSession }

    const first = await healCodexAccountSessionIndex(HOME, bridged('gone'), options)
    const second = await healCodexAccountSessionIndex(HOME, bridged('gone'), options)

    expect(first).toEqual({
      outcome: 'completed',
      healedThreads: 0,
      missingThreads: 1,
      failedThreads: 0
    })
    expect(second.outcome).toBe('up-to-date')
    expect(readThreadIds).toEqual(['gone'])
  })

  it('retries a thread on the next pass when the app-server session fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('codex app-server exited before responding')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const readIndexedThreadIds = (): Set<string> => new Set()

    const first = await healCodexAccountSessionIndex(HOME, bridged('a'), {
      readIndexedThreadIds,
      buildInvocation,
      runSession: failing
    })
    const { runSession, readThreadIds } = fakeAppServer()
    const second = await healCodexAccountSessionIndex(HOME, bridged('a'), {
      readIndexedThreadIds,
      buildInvocation,
      runSession
    })

    expect(first.outcome).toBe('aborted')
    expect(second.outcome).toBe('completed')
    expect(readThreadIds).toEqual(['a'])
    warn.mockRestore()
  })

  it('reports a session that fails during quit as stopped, not unsupported', async () => {
    let stopping = false
    const summary = await healCodexAccountSessionIndex(HOME, bridged('a'), {
      readIndexedThreadIds: () => new Set(),
      buildInvocation,
      runSession: async () => {
        stopping = true
        throw new CodexAppServerUnsupportedError('app-server killed during quit')
      },
      shouldStop: () => stopping
    })

    expect(summary.outcome).toBe('stopped')
  })

  it('aborts rather than writing off a thread while a live Codex holds the database', async () => {
    const { runSession } = fakeAppServer(() => {
      throw new Error('codex app-server thread/read failed: database is locked')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const summary = await healCodexAccountSessionIndex(HOME, bridged('a'), {
      readIndexedThreadIds: () => new Set(),
      buildInvocation,
      runSession
    })

    expect(summary).toEqual({
      outcome: 'aborted',
      healedThreads: 0,
      missingThreads: 0,
      failedThreads: 0
    })
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
