import { describe, expect, it } from 'vitest'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { codexPrimaryCommandTaskId } from '../../../../shared/structured-session-foreground-commands'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { terminateCodexBackgroundTerminals } from './codex-background-terminals'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID,
  type Route
} from '../session-lifecycle/codex-structured-session-adapter-fixture'

const TURN_ID = 'turn-1'
const PROCESS_ID = '71831'
const TASK_ID = codexPrimaryCommandTaskId('exec-1')

type Call = { method: string; params?: Record<string, unknown> }

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

async function backgroundedDevServer(codex: ReturnType<typeof codexWith>): Promise<void> {
  await acquireReadyCodexForTest(codex.adapter, { identity, fence: 7, spawnToken: 'spawn-1' })
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

describe('Codex background-command Stop', () => {
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

describe('terminateCodexBackgroundTerminals', () => {
  const always = { timeoutMs: 5_000, isCurrent: () => true }

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
})
