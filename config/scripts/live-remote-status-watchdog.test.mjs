import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoundedLiveFreezeHistory } from './live-freeze-bounded-history.mjs'
import { resolveOrcaCliInvocation } from './live-remote-freeze-rpc.mjs'

const { code } = transformSync(
  readFileSync(new URL('./live-remote-status-watchdog.mjs', import.meta.url), 'utf8'),
  { format: 'cjs' }
)

function createWatchdog(options = {}) {
  const children = []
  const spawn = vi.fn(() => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    children.push(child)
    return child
  })
  const dependencies = {
    'node:child_process': { spawn },
    './live-freeze-bounded-history.mjs': { BoundedLiveFreezeHistory },
    './live-remote-freeze-rpc.mjs': { resolveOrcaCliInvocation }
  }
  const module = { exports: {} }
  runInNewContext(code, {
    module,
    require: (id) => {
      if (!Object.hasOwn(dependencies, id)) {
        throw new Error(`Unexpected watchdog dependency: ${id}`)
      }
      return dependencies[id]
    },
    performance,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  })
  const watch = module.exports.startStatusWatchdog({
    cliCommand: 'fixture-orca',
    intervalMs: 100,
    timeoutMs: 50,
    ...options
  })
  return { watch, children, spawn }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('startStatusWatchdog', () => {
  it('records success, nonzero exit and timeout before a final sample and clean stop', async () => {
    const { watch, children, spawn } = createWatchdog()
    await vi.advanceTimersByTimeAsync(10)
    children[0].emit('close', 0)
    await vi.advanceTimersByTimeAsync(90)
    await vi.advanceTimersByTimeAsync(20)
    children[1].emit('close', 2)
    await vi.advanceTimersByTimeAsync(130)
    expect(children[2].kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    children[2].emit('close', 0)

    const stopping = watch.stop()
    await vi.advanceTimersByTimeAsync(5)
    children[3].emit('close', 0)
    const result = await stopping

    expect(result).toEqual({
      samples: [
        { tMs: 0, ms: 10, ok: true, hang: false },
        { tMs: 100, ms: 20, ok: false, hang: false },
        { tMs: 200, ms: 50, ok: false, hang: true },
        { tMs: 250, ms: 5, ok: true, hang: false }
      ],
      sampleCount: 4,
      maxStatusMs: 50,
      unhealthySampleCount: 2,
      infrastructureErrorCount: 0,
      longestUnhealthyWindowMs: 150,
      durationMs: 255
    })
    expect(spawn).toHaveBeenCalledWith('fixture-orca', ['status', '--json'], {
      env: undefined,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(children).toHaveLength(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for an in-flight spawn failure and classifies the final error without a hang', async () => {
    const { watch, children } = createWatchdog()
    const stopping = watch.stop()
    await vi.advanceTimersByTimeAsync(5)
    children[0].emit('error', new Error('spawn ENOENT'))
    children[0].emit('close', 1)
    await vi.advanceTimersByTimeAsync(15)
    await vi.advanceTimersByTimeAsync(3)
    children[1].emit('error', new Error('spawn EACCES'))

    expect(await stopping).toEqual({
      samples: [
        {
          tMs: 0,
          ms: 5,
          ok: false,
          hang: false,
          infrastructureError: true,
          error: 'Error: spawn ENOENT'
        },
        {
          tMs: 20,
          ms: 3,
          ok: false,
          hang: false,
          infrastructureError: true,
          error: 'Error: spawn EACCES'
        }
      ],
      sampleCount: 2,
      maxStatusMs: 5,
      unhealthySampleCount: 0,
      infrastructureErrorCount: 2,
      longestUnhealthyWindowMs: 0,
      durationMs: 23
    })
    expect(children.every((child) => child.kill.mock.calls.length === 0)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds retained samples while preserving full-run counters and slow-success peaks', async () => {
    const { watch, children } = createWatchdog({ sampleHistoryLimit: 1, statusSlowMs: 40 })
    await vi.advanceTimersByTimeAsync(5)
    children[0].emit('error', new Error('spawn ENOENT'))
    await vi.advanceTimersByTimeAsync(95)
    await vi.advanceTimersByTimeAsync(45)
    children[1].emit('close', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.getSummary()).toEqual({
      sampleCount: 2,
      maxStatusMs: 45,
      unhealthySampleCount: 1,
      infrastructureErrorCount: 1,
      longestUnhealthyWindowMs: 45
    })
    expect(watch.getSamples()).toEqual([{ tMs: 100, ms: 45, ok: true, hang: false }])

    const stopping = watch.stop()
    await vi.advanceTimersByTimeAsync(5)
    children[2].emit('close', 0)
    expect(await stopping).toEqual({
      samples: [{ tMs: 145, ms: 5, ok: true, hang: false }],
      sampleCount: 3,
      maxStatusMs: 45,
      unhealthySampleCount: 1,
      infrastructureErrorCount: 1,
      longestUnhealthyWindowMs: 45,
      durationMs: 150
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
