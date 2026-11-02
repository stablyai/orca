import { describe, expect, it } from 'vitest'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { codexPrimaryCommandTaskId } from '../../shared/structured-session-foreground-commands'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import { CodexAppServerTimeoutError } from './codex-app-server-session'
import {
  adapterFor,
  fakeCodex,
  identityFor,
  THREAD_ID,
  type Route
} from './codex-structured-session-adapter-fixture'

const HELPER = 'thread-helper'
const HELPER_TURN = 'helper-turn-1'
const identity = identityFor('session-1')

function refusal(code: number, message: string): CodexAppServerRequestError {
  return new CodexAppServerRequestError(
    'turn/interrupt',
    code,
    `codex app-server turn/interrupt failed: ${message}`,
    message
  )
}

/** A session whose turn spawned `HELPER`, which is still working on its own first turn. */
async function runningHelper(routes: Record<string, Route>) {
  const codex = fakeCodex(routes)
  const evidence: AgentChildWorkEvidence[] = []
  const adapter = adapterFor(codex, {}, [], {
    onChildWorkEvidence: (_sessionId, edges) => evidence.push(...edges)
  })
  const live = () => codex.connections.at(-1)!
  const notify = (method: string, params: unknown): void =>
    live().handlers.onNotification?.(method, params)
  await adapter.acquire({ identity, fence: 7, spawnToken: 'spawn-1' })
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

function helperEdges(evidence: AgentChildWorkEvidence[]) {
  return evidence.filter(
    (edge) =>
      (edge.type === 'live'
        ? edge.child.handle.id
        : edge.type === 'ended'
          ? edge.handle.id
          : null) === HELPER
  )
}

describe('Codex sub-agent Stop', () => {
  it('offers a sub-agent its own Stop and interrupts the turn it runs', async () => {
    const codex = await runningHelper({ 'turn/interrupt': () => ({}) })
    expect(codex.adapter.backgroundTaskStops('session-1')).toEqual({
      supportsTaskStop: true,
      supportsStopAll: false
    })
    expect(helperEdges(codex.evidence).at(-1)).toMatchObject({
      type: 'live',
      child: { kind: 'agent', stoppable: true }
    })

    await expect(codex.stop([HELPER])).resolves.toEqual({ cancelled: true })
    expect(codex.interrupts()).toEqual([{ threadId: HELPER, turnId: HELPER_TURN }])

    codex.notify('turn/completed', {
      threadId: HELPER,
      turn: { id: HELPER_TURN, status: 'interrupted' }
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(helperEdges(codex.evidence).at(-1)).toMatchObject({
      type: 'ended',
      outcome: 'cancelled'
    })
    // Its turn is over: a second Stop has nothing to name.
    await expect(codex.stop([HELPER])).resolves.toEqual({ cancelled: false })
    expect(codex.interrupts()).toHaveLength(1)
  })

  it.each([
    ['has no turn running', 'no active turn to interrupt'],
    [
      'has moved on to another turn',
      `expected active turn id ${HELPER_TURN} but found helper-turn-2`
    ],
    ['was unloaded', `thread not found: ${HELPER}`]
  ])('stays quiet when Codex says the child %s', async (_, message) => {
    const codex = await runningHelper({
      'turn/interrupt': () => {
        throw refusal(-32600, message)
      }
    })
    await expect(codex.stop([HELPER])).resolves.toEqual({ cancelled: false })
  })

  it('says the sub-agent still runs when Codex could not carry the interrupt out', async () => {
    const codex = await runningHelper({
      'turn/interrupt': () => {
        throw refusal(-32603, 'failed to interrupt turn')
      }
    })
    await expect(codex.stop([HELPER])).resolves.toEqual({ cancelled: false, stillRunning: true })
  })

  it.each([
    ['times out', new CodexAppServerTimeoutError('codex app-server turn/interrupt timed out')],
    ['loses the app-server', new Error('codex app-server connection closed')]
  ])('leaves the Stop unconfirmed when the interrupt %s', async (_, error) => {
    const codex = await runningHelper({
      'turn/interrupt': () => {
        throw error
      }
    })
    await expect(codex.stop([HELPER])).rejects.toBe(error)
  })

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

  it("ends the helper's own sub-agents with it", async () => {
    const codex = await runningHelper({ 'turn/interrupt': () => ({}) })
    codex.notify('item/started', {
      threadId: HELPER,
      turnId: HELPER_TURN,
      item: {
        type: 'subAgentActivity',
        id: 'spawn-nested',
        kind: 'started',
        agentThreadId: 'thread-nested',
        agentPath: '/root/helper/nested'
      }
    })
    codex.notify('turn/started', {
      threadId: 'thread-nested',
      turn: { id: 'nested-turn-1', status: 'inProgress' }
    })
    await new Promise((resolve) => setImmediate(resolve))

    await expect(codex.stop([HELPER])).resolves.toEqual({ cancelled: true })
    expect(codex.interrupts()).toEqual([
      { threadId: HELPER, turnId: HELPER_TURN },
      { threadId: 'thread-nested', turnId: 'nested-turn-1' }
    ])
  })

  it('terminates the command a helper is running, which its interrupt leaves running', async () => {
    const running = ['4343']
    const codex = await runningHelper({
      'turn/interrupt': () => ({}),
      'thread/backgroundTerminals/list': () => ({
        data: running.map((processId) => ({ processId })),
        nextCursor: null
      }),
      'thread/backgroundTerminals/terminate': (params) => {
        running.splice(running.indexOf(String(params?.processId)), 1)
        return { terminated: true }
      }
    })
    const command = (status: 'inProgress' | 'completed') => ({
      threadId: HELPER,
      turnId: HELPER_TURN,
      item: {
        type: 'commandExecution',
        id: 'helper-exec',
        processId: '4343',
        source: 'unifiedExecStartup',
        command: 'sleep 90',
        status
      }
    })
    codex.notify('item/started', command('inProgress'))
    await new Promise((resolve) => setImmediate(resolve))

    await expect(codex.stop([HELPER])).resolves.toEqual({ cancelled: true })
    expect(codex.interrupts()).toEqual([{ threadId: HELPER, turnId: HELPER_TURN }])
    expect(running).toEqual([])
    codex.notify('turn/completed', {
      threadId: HELPER,
      turn: { id: HELPER_TURN, status: 'interrupted' }
    })
    codex.notify('item/completed', command('completed'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(helperEdges(codex.evidence).at(-1)).toMatchObject({
      type: 'ended',
      outcome: 'cancelled'
    })
    expect(codex.evidence.at(-1)).toMatchObject({ type: 'removed' })
  })

  /** `runningHelper`, plus a dev server the session's own turn left running. */
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

  it('stops a sub-agent and a backgrounded command in one Stop', async () => {
    const codex = await helperAndDevServer(() => ({}))
    await expect(codex.stopBoth()).resolves.toEqual({ cancelled: true })
    expect(codex.interrupts()).toEqual([{ threadId: HELPER, turnId: HELPER_TURN }])
    expect(codex.running).toEqual([])
  })

  it('does not ask an app-server that timed out on the sub-agent to stop the command too', async () => {
    const timeout = new CodexAppServerTimeoutError('codex app-server turn/interrupt timed out')
    const codex = await helperAndDevServer(() => {
      throw timeout
    })
    await expect(codex.stopBoth()).rejects.toBe(timeout)
    expect(codex.terminated).toEqual([])
  })

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
