import { describe, expect, it } from 'vitest'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'

import { CodexAppServerTimeoutError } from '../../app-server/codex-app-server-session'
import {
  acquireReadyCodexForTest,
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID,
  type Route
} from '../session-lifecycle/codex-structured-session-adapter-fixture'

const HELPER = 'thread-helper'
const HELPER_TURN = 'helper-turn-1'
const identity = identityFor('session-1')

async function runningHelper(routes: Record<string, Route>) {
  const codex = fakeCodex(routes)
  const evidence: AgentChildWorkEvidence[] = []
  const adapter = adapterFor(codex, {}, [], {
    onChildWorkEvidence: (_sessionId, edges) => evidence.push(...edges)
  })
  const live = () => codex.connections.at(-1)!
  const notify = (method: string, params: unknown): void =>
    live().handlers.onNotification?.(method, params)
  await acquireReadyCodexForTest(adapter, { identity, fence: 7, spawnToken: 'spawn-1' })
  notify('turn/started', { threadId: THREAD_ID, turn: { id: 'turn-1', status: 'inProgress' } })
  notify('item/started', {
    threadId: THREAD_ID,
    turnId: 'turn-1',
    item: {
      type: 'subAgentActivity',
      id: 'spawn-helper',
      kind: 'started',
      agentThreadId: HELPER,
      agentPath: '/root/helper'
    }
  })
  notify('turn/started', { threadId: HELPER, turn: { id: HELPER_TURN, status: 'inProgress' } })
  notify('turn/completed', { threadId: THREAD_ID, turn: { id: 'turn-1', status: 'completed' } })
  await new Promise((resolve) => setImmediate(resolve))
  const interrupts = () =>
    live()
      .calls.filter((call) => call.method === 'turn/interrupt')
      .map((call) => call.params)
  const stop = (taskIds: string[], fence = 7) =>
    adapter.stopBackgroundTasks({ sessionId: 'session-1', fence, taskIds })
  const spawn = (parent: string, child: string, turnId: string) => {
    notify('item/started', {
      threadId: parent,
      turnId,
      item: {
        type: 'subAgentActivity',
        id: `spawn-${child}`,
        kind: 'started',
        agentThreadId: child,
        agentPath: `/root/${child}`
      }
    })
    notify('turn/started', {
      threadId: child,
      turn: { id: `${child}-turn`, status: 'inProgress' }
    })
  }
  return { adapter, evidence, notify, interrupts, stop, spawn }
}

describe('Codex sub-agent Stop', () => {
  it('stays quiet when the interrupt landed as the run ended and Codex held it unanswered', async () => {
    let endRun = (): void => {}
    const codex = await runningHelper({
      'turn/interrupt': async () => {
        endRun()
        await new Promise((resolve) => setImmediate(resolve))
        throw new CodexAppServerTimeoutError('codex app-server turn/interrupt timed out')
      }
    })
    endRun = () =>
      codex.notify('turn/completed', {
        threadId: HELPER,
        turn: { id: HELPER_TURN, status: 'completed' }
      })
    await expect(codex.stop([HELPER])).resolves.toEqual({ cancelled: false })
  })

  it('stops a resumed parent before descendants across a settled helper and its surviving shell', async () => {
    const timeout = new CodexAppServerTimeoutError('codex app-server turn/interrupt timed out')
    let timeOut = true
    let running = true
    const terminated: unknown[] = []
    const codex = await runningHelper({
      'turn/interrupt': (params) => {
        if (timeOut && params?.threadId === 'grandchild') {
          throw timeout
        }
        return {}
      },
      'thread/backgroundTerminals/list': (params) => ({
        data: running && params?.threadId === 'intermediary' ? [{ processId: '4343' }] : [],
        nextCursor: null
      }),
      'thread/backgroundTerminals/terminate': (params) => {
        terminated.push(params)
        running = false
        return { terminated: true }
      }
    })
    codex.spawn(HELPER, 'intermediary', HELPER_TURN)
    codex.spawn('intermediary', 'grandchild', 'intermediary-turn')
    codex.notify('item/started', {
      threadId: 'intermediary',
      turnId: 'intermediary-turn',
      item: {
        type: 'commandExecution',
        id: 'surviving-shell',
        processId: '4343',
        source: 'unifiedExecStartup',
        command: 'sleep 90',
        status: 'inProgress'
      }
    })
    for (const [threadId, id] of [
      ['intermediary', 'intermediary-turn'],
      [HELPER, HELPER_TURN]
    ]) {
      codex.notify('turn/completed', { threadId, turn: { id, status: 'completed' } })
    }
    codex.notify('turn/started', {
      threadId: HELPER,
      turn: { id: 'helper-turn-2', status: 'inProgress' }
    })
    await new Promise((resolve) => setImmediate(resolve))
    await expect(codex.stop(['grandchild', HELPER])).rejects.toBe(timeout)
    expect(codex.interrupts()).toEqual([
      { threadId: HELPER, turnId: 'helper-turn-2' },
      { threadId: 'grandchild', turnId: 'grandchild-turn' }
    ])
    expect(terminated).toEqual([])
    timeOut = false
    await expect(codex.stop([HELPER])).resolves.toEqual({ cancelled: true })
    expect(terminated).toEqual([{ threadId: 'intermediary', processId: '4343' }])
  })

  it('interrupts an explicitly named descendant before a sibling timeout across a commandless settled helper', async () => {
    const timeout = new CodexAppServerTimeoutError('codex app-server turn/interrupt timed out')
    const codex = await runningHelper({
      'turn/interrupt': (params) => {
        if (params?.threadId === 'earlier-sibling') {
          throw timeout
        }
        return {}
      }
    })
    codex.spawn(HELPER, 'earlier-sibling', HELPER_TURN)
    codex.spawn(HELPER, 'intermediary', HELPER_TURN)
    codex.spawn('intermediary', 'grandchild', 'intermediary-turn')
    codex.notify('turn/completed', {
      threadId: 'intermediary',
      turn: { id: 'intermediary-turn', status: 'completed' }
    })
    for (const taskIds of [
      [HELPER, 'grandchild'],
      ['grandchild', HELPER]
    ]) {
      await expect(codex.stop(taskIds)).rejects.toBe(timeout)
      expect(codex.interrupts().slice(-3)).toEqual([
        { threadId: HELPER, turnId: HELPER_TURN },
        { threadId: 'grandchild', turnId: 'grandchild-turn' },
        { threadId: 'earlier-sibling', turnId: 'earlier-sibling-turn' }
      ])
    }
  })
})
