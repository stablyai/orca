import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const workerState = vi.hoisted(() => ({
  instances: [] as {
    terminated: boolean
    workerData: unknown
    listeners: Map<string, (arg?: unknown) => void>
    emit: (event: string, arg?: unknown) => void
    terminate: () => Promise<number>
    removeAllListeners: () => void
  }[]
}))

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

vi.mock('worker_threads', () => ({
  Worker: class MockWorker {
    terminated = false
    workerData: unknown
    listeners = new Map<string, (arg?: unknown) => void>()

    constructor(_workerPath: string, options: { workerData?: unknown }) {
      this.workerData = options.workerData
      workerState.instances.push(this)
    }

    once(event: string, listener: (arg?: unknown) => void): this {
      this.listeners.set(event, listener)
      return this
    }

    removeAllListeners(): void {
      this.listeners.clear()
    }

    async terminate(): Promise<number> {
      this.terminated = true
      return 0
    }

    emit(event: string, arg?: unknown): void {
      this.listeners.get(event)?.(arg)
    }
  }
}))

import { parseWarpThemeYamlWithTimeout, WARP_THEME_PARSE_TIMEOUT_MS } from './parser-runner'

describe('parseWarpThemeYamlWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    workerState.instances.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns worker parser results', async () => {
    const resultPromise = parseWarpThemeYamlWithTimeout('name: Test', 'test.yaml')
    const worker = workerState.instances[0]
    worker?.emit('message', { ok: false, reason: 'Invalid YAML' })

    await expect(resultPromise).resolves.toEqual({ ok: false, reason: 'Invalid YAML' })
    expect(worker?.terminated).toBe(false)
  })

  it('terminates the worker when parsing exceeds the budget', async () => {
    const resultPromise = parseWarpThemeYamlWithTimeout('name: Slow', 'slow.yaml')
    const worker = workerState.instances[0]

    await vi.advanceTimersByTimeAsync(WARP_THEME_PARSE_TIMEOUT_MS)

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: 'Theme file took too long to parse.'
    })
    expect(worker?.terminated).toBe(true)
  })

  it('uses the shorter operation-budget timeout when provided', async () => {
    const resultPromise = parseWarpThemeYamlWithTimeout(
      'name: Slow',
      'slow.yaml',
      {},
      {
        timeoutMs: 25
      }
    )
    const worker = workerState.instances[0]

    await vi.advanceTimersByTimeAsync(24)
    expect(worker?.terminated).toBe(false)

    await vi.advanceTimersByTimeAsync(1)

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      reason: 'Theme file took too long to parse.'
    })
    expect(worker?.terminated).toBe(true)
  })
})
