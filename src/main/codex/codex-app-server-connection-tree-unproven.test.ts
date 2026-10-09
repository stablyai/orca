import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import type { ProviderProcessTeardownVerdict } from '../provider-process/provider-process-teardown'
import { openCodexAppServerConnection } from './codex-app-server-connection'

const teardown = vi.hoisted(() => {
  const state: { verdict: ProviderProcessTeardownVerdict; rootExits: () => void } = {
    verdict: null,
    rootExits: () => {}
  }
  return state
})
vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: vi.fn(async () => {
    teardown.rootExits()
    return teardown.verdict
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
  // The flag keeps its meaning: a forced teardown that did not prove the descendants gone.
  it.each([
    ['unverifiable', true],
    ['live', true],
    ['exited', false],
    [null, false]
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
    // A repeat close answers from the memo and keeps the diagnostic.
    await expect(connection.close()).resolves.toBe(true)
    expect(connection.processTreeUnproven).toBe(unproven)
  })
})
