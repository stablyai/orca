import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '@orca/process-host'
import type { DescendantTreeVerdict } from '../../pty/process-retirement/pty-descendant-exit-verification'

import { openCodexAppServerConnection } from './codex-app-server-connection'

const teardown = vi.hoisted(() => {
  const state: { verdict: DescendantTreeVerdict; rootExits: () => void } = {
    verdict: 'unverifiable',
    rootExits: () => {}
  }
  return state
})
vi.mock('../../claude/child-process/claude-agent-sdk-exit-proof', () => ({
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
