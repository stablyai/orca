import { describe, expect, it } from 'vitest'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { codexPrimaryCommandTaskId } from '../../../../shared/structured-session-foreground-commands'
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
  return { adapter, evidence, notify, interrupts, stop }
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

  it('sends nothing for a task that is not a running sub-agent, or for a stale fence', async () => {
    const codex = await runningHelper({ 'turn/interrupt': () => ({}) })
    await expect(codex.stop(['thread-unknown'])).resolves.toEqual({ cancelled: false })
    await expect(codex.stop([HELPER], 6)).resolves.toEqual({ cancelled: false })
    expect(codex.interrupts()).toEqual([])
  })

  async function helperAndDevServer(interrupt: Route) {
    const running = ['4242']
    const terminated: unknown[] = []
    const codex = await runningHelper({
      'turn/interrupt': interrupt,
      'thread/backgroundTerminals/list': () => ({
        data: running.map((processId) => ({ processId })),
        nextCursor: null
      }),
      'thread/backgroundTerminals/terminate': (params) => {
        terminated.push(params)
        running.splice(running.indexOf(String(params?.processId)), 1)
        return { terminated: true }
      }
    })
    codex.notify('item/started', {
      threadId: THREAD_ID,
      turnId: 'turn-1',
      item: {
        type: 'commandExecution',
        id: 'exec-1',
        processId: '4242',
        source: 'unifiedExecStartup',
        command: 'pnpm dev',
        status: 'inProgress'
      }
    })
    await new Promise((resolve) => setImmediate(resolve))
    const stopBoth = () => codex.stop([HELPER, codexPrimaryCommandTaskId('exec-1')])
    return { ...codex, running, terminated, stopBoth }
  }

  it("leaves a helper's sibling and the session's own background process alone", async () => {
    const codex = await helperAndDevServer(() => ({}))
    codex.notify('item/started', {
      threadId: THREAD_ID,
      turnId: 'turn-1',
      item: {
        type: 'subAgentActivity',
        id: 'spawn-sibling',
        kind: 'started',
        agentThreadId: 'thread-sibling',
        agentPath: '/root/sibling'
      }
    })
    codex.notify('turn/started', {
      threadId: 'thread-sibling',
      turn: { id: 'sibling-turn-1', status: 'inProgress' }
    })
    await new Promise((resolve) => setImmediate(resolve))

    await expect(codex.stop([HELPER])).resolves.toEqual({ cancelled: true })
    expect(codex.interrupts()).toEqual([{ threadId: HELPER, turnId: HELPER_TURN }])
    expect(codex.terminated).toEqual([])
    expect(codex.running).toEqual(['4242'])
  })

  it("does not terminate a helper's processes once its interrupt timed out", async () => {
    const timeout = new CodexAppServerTimeoutError('codex app-server turn/interrupt timed out')
    const codex = await helperAndDevServer(() => {
      throw timeout
    })
    codex.notify('item/started', {
      threadId: HELPER,
      turnId: HELPER_TURN,
      item: {
        type: 'commandExecution',
        id: 'helper-exec',
        processId: '4343',
        source: 'unifiedExecStartup',
        command: 'sleep 90',
        status: 'inProgress'
      }
    })
    await new Promise((resolve) => setImmediate(resolve))

    await expect(codex.stop([HELPER])).rejects.toBe(timeout)
    expect(codex.terminated).toEqual([])
  })
})
