import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '@orca/process-host'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { providerRequestTimeoutOf } from '../provider-process/provider-request-timeout'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { CodexAppServerTimeoutError } from './codex-app-server-session'
import { codexTurnLifecycleRig } from './codex-structured-dispatch-test-support'

const teardown = vi.hoisted(() => {
  const state: { verdict: DescendantTreeVerdict; rootExits: () => void } = {
    verdict: 'unverifiable',
    rootExits: () => {}
  }
  return state
})
vi.mock('../claude/claude-agent-sdk-exit-proof', () => ({
  createClaudeChildTreeReaper: () => ({
    capture: async () => {},
    refresh: async () => {},
    reap: async () => {
      teardown.rootExits()
      return teardown.verdict
    },
    get treeVerdict() {
      return teardown.verdict
    }
  })
}))

afterEach(() => {
  vi.useRealTimers()
})

function stubChild() {
  const child = Object.assign(new EventEmitter(), {
    pid: 9_999_999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  child.stdin.once('data', () => {
    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The connection reads only events, pid, streams and kill from this stub.
  const spawnImpl = (() => child) as unknown as typeof spawnProcess
  return { child, spawnImpl }
}

describe('Codex process-tree diagnostic after a forced close', () => {
  it.each([undefined, 'turn-1'])(
    'bounds unanswered Stop %s and ignores its late reply after replacement',
    async (turnId) => {
      const rig = await codexTurnLifecycleRig()
      const session = rig.adapter['sessions'].get('session-1')!
      session.activeTurnIds?.add('turn-1')
      vi.useFakeTimers()
      const { child, spawnImpl } = stubChild()
      const connection = await openCodexAppServerConnection(
        { command: 'codex', args: [] },
        {},
        spawnImpl
      )
      const original = session.connection
      session.connection = connection
      const acceptedAt = Date.now()
      const stopping = rig.adapter.cancelTurn({
        sessionId: 'session-1',
        fence: 7,
        turnId,
        stoppedAt: Date.now() - 4_900
      })
      let settled = false
      const observed = stopping.then((outcome) => {
        settled = true
        return outcome
      })
      await vi.advanceTimersByTimeAsync(99)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const outcome = await observed
      expect(Date.now() - acceptedAt).toBe(100)
      expect(outcome).toMatchObject({
        cancelled: false,
        stop: {
          pause: 'unconfirmed',
          interrupt: 'unconfirmed',
          root: 'unproven',
          workload: 'unproven'
        }
      })
      const timeouts = outcome.stop?.errors.flatMap((error) =>
        error instanceof CodexAppServerTimeoutError && 'providerRequestTimeout' in error
          ? [error.providerRequestTimeout]
          : []
      )
      expect(timeouts).toEqual([
        { method: 'thread/goal/get', timeoutMs: expect.closeTo(100 / 3, 3) },
        { method: 'turn/interrupt', timeoutMs: 67 }
      ])
      expect(providerRequestTimeoutOf(outcome.stop?.errors[1])).toEqual({
        method: 'turn/interrupt',
        timeoutMs: 67
      })
      expect(outcome.stop?.errors).toHaveLength(3)
      expect(outcome.stop?.errors[2]).toEqual(new Error('codex Stop reconciliation unavailable'))
      const replacement = {
        ...session,
        connection: original,
        fence: 8,
        abortedTurnIds: new Set<string>()
      }
      rig.adapter['sessions'].set('session-1', replacement)
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      child.stdout.write(`${JSON.stringify({ id: 2, result: {} })}\n`)
      await vi.advanceTimersByTimeAsync(0)
      expect(replacement.abortedTurnIds.size).toBe(0)
      expect(warning).toHaveBeenCalled()
      warning.mockRestore()
      teardown.rootExits = () => child.emit('exit', 0, null)
      const closing = connection.close()
      await vi.advanceTimersByTimeAsync(10_000)
      await closing
      await rig.adapter.closeAll()
    }
  )

  it.each([
    ['unverifiable', true],
    ['live', true],
    ['exited', false]
  ] as const)('teardown observing %s reads unproven=%s', async (verdict, unproven) => {
    vi.useFakeTimers()
    teardown.verdict = verdict
    const { child, spawnImpl } = stubChild()
    teardown.rootExits = () => child.emit('exit', null, 'SIGKILL')
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      {},
      spawnImpl
    )
    const closing = connection.close()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(closing).resolves.toBe(true)
    expect(connection.processTreeUnproven).toBe(unproven)
    await expect(connection.close()).resolves.toBe(true)
    expect(connection.processTreeUnproven).toBe(unproven)
  })

  it('reports a root exit that arrives after an unproven close', async () => {
    vi.useFakeTimers()
    teardown.verdict = 'unverifiable'
    teardown.rootExits = () => {}
    const { child, spawnImpl } = stubChild()
    const onExit = vi.fn()
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit },
      spawnImpl
    )
    const closing = connection.close()
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(closing).resolves.toBe(false)
    expect(onExit).not.toHaveBeenCalled()
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith(expect.any(Error), { expected: true })
    expect(connection.closeResult).toMatchObject({ root: 'exited', tree: 'unverifiable' })
    expect(connection.processTreeUnproven).toBe(true)
  })
})
