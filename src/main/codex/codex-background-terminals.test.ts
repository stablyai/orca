import { describe, expect, it } from 'vitest'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { codexPrimaryCommandTaskId } from '../../shared/structured-session-foreground-commands'
import {
  CodexAppServerRequestError,
  type CodexAppServerConnection
} from './codex-app-server-connection'
import {
  CodexAppServerTimeoutError,
  CodexAppServerUnsupportedError
} from './codex-app-server-session'
import {
  probeCodexBackgroundTerminals,
  terminateCodexBackgroundTerminals
} from './codex-background-terminals'
import {
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID,
  type Route
} from './codex-structured-session-adapter-fixture'

const TURN_ID = 'turn-1'
const PROCESS_ID = '71831'
const TASK_ID = codexPrimaryCommandTaskId('exec-1')

type Call = { method: string; params?: Record<string, unknown> }

function unknownVariant(method: string): CodexAppServerRequestError {
  const message = `Invalid request: unknown variant \`${method}\``
  return new CodexAppServerRequestError(
    method,
    -32600,
    `codex app-server ${method} failed: ${message}`,
    message
  )
}

function threadNotFound(method: string): CodexAppServerRequestError {
  const message = `thread not found: ${THREAD_ID}`
  return new CodexAppServerRequestError(
    method,
    -32600,
    `codex app-server ${method} failed: ${message}`,
    message
  )
}

/** Answers each request from `routes`, as a live app-server would, and records it. */
function fakeRpc(routes: Record<string, Route>): {
  rpc: Pick<CodexAppServerConnection, 'request'>
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    rpc: {
      request: async (method, params) => {
        calls.push({ method, params })
        const route = routes[method]
        return route ? route(params) : {}
      }
    }
  }
}

function codexWith(routes: Record<string, Route>) {
  const codex = fakeCodex(routes)
  const evidence: AgentChildWorkEvidence[] = []
  const adapter = adapterFor(codex, {}, [], {
    onChildWorkEvidence: (_sessionId, edges) => evidence.push(...edges)
  })
  const live = () => codex.connections.at(-1)!
  const calls = (): Call[] => live().calls
  const notify = (method: string, params: unknown): void =>
    live().handlers.onNotification?.(method, params)
  return { adapter, calls, evidence, notify }
}

const identity = identityFor('session-1')

function commandItem(status: 'inProgress' | 'completed') {
  return {
    type: 'commandExecution',
    id: 'exec-1',
    processId: PROCESS_ID,
    source: 'unifiedExecStartup',
    command: 'pnpm dev',
    status
  }
}

/** A turn that starts a dev server and ends with it still running. */
async function backgroundedDevServer(codex: ReturnType<typeof codexWith>): Promise<void> {
  await codex.adapter.acquire({ identity, fence: 7, spawnToken: 'spawn-1' })
  codex.notify('turn/started', { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } })
  codex.notify('item/started', {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    item: commandItem('inProgress')
  })
  await new Promise((resolve) => setImmediate(resolve))
  codex.notify('turn/completed', {
    threadId: THREAD_ID,
    turn: { id: TURN_ID, status: 'completed' }
  })
}

function lastCommandStoppable(evidence: AgentChildWorkEvidence[]): boolean | undefined {
  const live = evidence.filter(
    (edge): edge is Extract<AgentChildWorkEvidence, { type: 'live' }> =>
      edge.type === 'live' && edge.child.handle.id === TASK_ID
  )
  return live.at(-1)?.child.stoppable
}

describe('Codex background-command Stop', () => {
  it('offers a Stop once the app-server lists background terminals, and terminates by process id', async () => {
    let running = [PROCESS_ID]
    const codex = codexWith({
      'thread/backgroundTerminals/list': () => ({
        data: running.map((processId) => ({ itemId: 'exec-1', processId, command: 'pnpm dev' })),
        nextCursor: null
      }),
      'thread/backgroundTerminals/terminate': (params) => {
        running = running.filter((processId) => processId !== params?.processId)
        return { terminated: true }
      }
    })
    await backgroundedDevServer(codex)

    expect(
      codex.calls().filter((call) => call.method === 'thread/backgroundTerminals/list')
    ).toEqual([
      { method: 'thread/backgroundTerminals/list', params: { threadId: THREAD_ID, limit: 1 } }
    ])
    expect(codex.adapter.backgroundTaskStops('session-1')).toEqual({
      supportsTaskStop: true,
      supportsStopAll: true
    })
    expect(lastCommandStoppable(codex.evidence)).toBe(true)

    await expect(
      codex.adapter.stopBackgroundTasks({ sessionId: 'session-1', fence: 7, taskIds: [TASK_ID] })
    ).resolves.toEqual({ cancelled: true })
    expect(codex.calls().slice(-2)).toEqual([
      {
        method: 'thread/backgroundTerminals/terminate',
        params: { threadId: THREAD_ID, processId: PROCESS_ID }
      },
      { method: 'thread/backgroundTerminals/list', params: { threadId: THREAD_ID } }
    ])
  })

  it('keeps an older Codex without background terminals at no Stop', async () => {
    const codex = codexWith({
      'thread/backgroundTerminals/list': () => {
        throw unknownVariant('thread/backgroundTerminals/list')
      }
    })

    await backgroundedDevServer(codex)

    expect(codex.adapter.backgroundTaskStops('session-1')).toEqual({
      supportsTaskStop: false,
      supportsStopAll: false
    })
    expect(lastCommandStoppable(codex.evidence)).toBe(false)
    await expect(
      codex.adapter.stopBackgroundTasks({ sessionId: 'session-1', fence: 7, taskIds: [TASK_ID] })
    ).resolves.toEqual({ cancelled: false })
    expect(
      codex.calls().some((call) => call.method === 'thread/backgroundTerminals/terminate')
    ).toBe(false)
  })

  it('restates an already backgrounded command as stoppable when the probe answers late', async () => {
    let answer: (value: unknown) => void = () => {}
    const codex = codexWith({
      'thread/backgroundTerminals/list': () =>
        new Promise((resolve) => {
          answer = resolve
        })
    })
    await backgroundedDevServer(codex)
    expect(lastCommandStoppable(codex.evidence)).toBe(false)
    expect(codex.adapter.backgroundTaskStops('session-1')).toEqual({
      supportsTaskStop: false,
      supportsStopAll: false
    })

    answer({ data: [], nextCursor: null })
    await new Promise((resolve) => setImmediate(resolve))

    expect(lastCommandStoppable(codex.evidence)).toBe(true)
    expect(codex.adapter.backgroundTaskStops('session-1')?.supportsTaskStop).toBe(true)
  })

  it('probes the app-server once, not per command', async () => {
    const codex = codexWith({
      'thread/backgroundTerminals/list': () => ({ data: [], nextCursor: null })
    })
    await backgroundedDevServer(codex)
    codex.notify('item/started', {
      threadId: THREAD_ID,
      turnId: 'turn-2',
      item: { ...commandItem('inProgress'), id: 'exec-2', processId: '71832' }
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(
      codex.calls().filter((call) => call.method === 'thread/backgroundTerminals/list')
    ).toHaveLength(1)
  })

  it('asks again after a probe that timed out, instead of hiding Stop for good', async () => {
    let probes = 0
    const codex = codexWith({
      'thread/backgroundTerminals/list': () => {
        probes += 1
        if (probes === 1) {
          throw new CodexAppServerTimeoutError('codex app-server timed out')
        }
        return { data: [], nextCursor: null }
      }
    })
    await codex.adapter.acquire({ identity, fence: 7, spawnToken: 'spawn-1' })
    codex.notify('turn/started', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'inProgress' }
    })
    codex.notify('item/started', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: commandItem('inProgress')
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(probes).toBe(1)
    expect(codex.adapter.backgroundTaskStops('session-1')?.supportsTaskStop).toBe(false)

    codex.notify('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: 'completed' }
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(probes).toBe(2)
    expect(codex.adapter.backgroundTaskStops('session-1')?.supportsTaskStop).toBe(true)
    expect(lastCommandStoppable(codex.evidence)).toBe(true)
  })

  it('stops nothing for a stale fence', async () => {
    const codex = codexWith({
      'thread/backgroundTerminals/list': () => ({ data: [], nextCursor: null })
    })
    await backgroundedDevServer(codex)
    await expect(
      codex.adapter.stopBackgroundTasks({ sessionId: 'session-1', fence: 6, taskIds: [TASK_ID] })
    ).resolves.toEqual({ cancelled: false })
    expect(
      codex.calls().some((call) => call.method === 'thread/backgroundTerminals/terminate')
    ).toBe(false)
  })
})

describe('probeCodexBackgroundTerminals', () => {
  const probe = (error: Error | null, reply: unknown = { data: [] }) =>
    probeCodexBackgroundTerminals(
      fakeRpc({
        'thread/backgroundTerminals/list': () => {
          if (error) {
            throw error
          }
          return reply
        }
      }).rpc,
      THREAD_ID,
      5_000
    )

  it('reads a listing as support and a refused method as none', async () => {
    await expect(probe(null)).resolves.toBe('supported')
    await expect(probe(unknownVariant('thread/backgroundTerminals/list'))).resolves.toBe(
      'unsupported'
    )
    await expect(
      probe(new CodexAppServerUnsupportedError('codex app-server does not support it'))
    ).resolves.toBe('unsupported')
    await expect(probe(null, {})).resolves.toBe('unsupported')
  })

  it('leaves the answer open when the app-server did not answer', async () => {
    await expect(probe(new CodexAppServerTimeoutError('codex app-server timed out'))).resolves.toBe(
      'unknown'
    )
    await expect(probe(new Error('codex app-server connection closed'))).resolves.toBe('unknown')
    await expect(probe(threadNotFound('thread/backgroundTerminals/list'))).resolves.toBe('unknown')
  })
})

describe('terminateCodexBackgroundTerminals', () => {
  const always = { timeoutMs: 5_000, isCurrent: () => true }

  it('counts a process Codex no longer holds as stopped once the list confirms it', async () => {
    const { rpc } = fakeRpc({
      'thread/backgroundTerminals/terminate': () => ({ terminated: false }),
      'thread/backgroundTerminals/list': () => ({ data: [], nextCursor: null })
    })
    await expect(
      terminateCodexBackgroundTerminals(
        rpc,
        [{ threadId: THREAD_ID, processId: PROCESS_ID }],
        always
      )
    ).resolves.toEqual({ stopped: 1, survived: false })
  })

  it('answers a survivor the list shows, after trying the others', async () => {
    const { rpc, calls } = fakeRpc({
      'thread/backgroundTerminals/terminate': () => ({ terminated: true }),
      'thread/backgroundTerminals/list': () => ({
        data: [{ processId: PROCESS_ID }],
        nextCursor: null
      })
    })
    await expect(
      terminateCodexBackgroundTerminals(
        rpc,
        [
          { threadId: THREAD_ID, processId: PROCESS_ID },
          { threadId: THREAD_ID, processId: '71832' }
        ],
        always
      )
    ).resolves.toEqual({ stopped: 1, survived: true })
    expect(
      calls.filter((call) => call.method === 'thread/backgroundTerminals/terminate')
    ).toHaveLength(2)
  })

  it('reads every page of the list', async () => {
    const { rpc } = fakeRpc({
      'thread/backgroundTerminals/terminate': () => ({ terminated: true }),
      'thread/backgroundTerminals/list': (params) =>
        params?.cursor === 'page-2'
          ? { data: [{ processId: PROCESS_ID }], nextCursor: null }
          : { data: [{ processId: '1' }], nextCursor: 'page-2' }
    })
    await expect(
      terminateCodexBackgroundTerminals(
        rpc,
        [{ threadId: THREAD_ID, processId: PROCESS_ID }],
        always
      )
    ).resolves.toEqual({ stopped: 0, survived: true })
  })

  it('answers a listed survivor even when another request timed out', async () => {
    const { rpc } = fakeRpc({
      'thread/backgroundTerminals/terminate': () => ({ terminated: true }),
      'thread/backgroundTerminals/list': (params) => {
        if (params?.threadId === 'thread-2') {
          throw new CodexAppServerTimeoutError('codex app-server timed out')
        }
        return { data: [{ processId: PROCESS_ID }], nextCursor: null }
      }
    })
    await expect(
      terminateCodexBackgroundTerminals(
        rpc,
        [
          { threadId: THREAD_ID, processId: PROCESS_ID },
          { threadId: 'thread-2', processId: '71832' }
        ],
        always
      )
    ).resolves.toEqual({ stopped: 0, survived: true })
  })

  it('counts a thread Codex unloaded as stopped', async () => {
    const { rpc } = fakeRpc({
      'thread/backgroundTerminals/terminate': () => {
        throw threadNotFound('thread/backgroundTerminals/terminate')
      }
    })
    await expect(
      terminateCodexBackgroundTerminals(
        rpc,
        [{ threadId: THREAD_ID, processId: PROCESS_ID }],
        always
      )
    ).resolves.toEqual({ stopped: 1, survived: false })
  })

  it('never counts a dropped connection as stopped', async () => {
    const closed = new Error('codex app-server connection closed')
    const onTerminate = fakeRpc({
      'thread/backgroundTerminals/terminate': () => {
        throw closed
      }
    })
    await expect(
      terminateCodexBackgroundTerminals(
        onTerminate.rpc,
        [{ threadId: THREAD_ID, processId: PROCESS_ID }],
        always
      )
    ).rejects.toBe(closed)
    const onConfirm = fakeRpc({
      'thread/backgroundTerminals/terminate': () => ({ terminated: true }),
      'thread/backgroundTerminals/list': () => {
        throw closed
      }
    })
    await expect(
      terminateCodexBackgroundTerminals(
        onConfirm.rpc,
        [{ threadId: THREAD_ID, processId: PROCESS_ID }],
        always
      )
    ).rejects.toBe(closed)
  })

  it('stops asking an app-server that timed out', async () => {
    const { rpc, calls } = fakeRpc({
      'thread/backgroundTerminals/terminate': () => {
        throw new CodexAppServerTimeoutError('codex app-server timed out')
      }
    })
    await expect(
      terminateCodexBackgroundTerminals(
        rpc,
        [
          { threadId: THREAD_ID, processId: PROCESS_ID },
          { threadId: THREAD_ID, processId: '71832' }
        ],
        always
      )
    ).rejects.toThrow('timed out')
    expect(calls).toHaveLength(1)
  })
})
