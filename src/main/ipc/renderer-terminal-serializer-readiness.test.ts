import { describe, expect, it, vi } from 'vitest'
import { RendererTerminalSerializerReadiness } from './renderer-terminal-serializer-readiness'

describe('RendererTerminalSerializerReadiness', () => {
  it('resolves current and future waiters when the renderer settles', async () => {
    const readiness = new RendererTerminalSerializerReadiness()
    const pending = readiness.wait('pty-1', 0, 1_000)

    readiness.markReady('pty-1')

    await expect(pending).resolves.toBe(true)
    expect(readiness.generation('pty-1')).toBe(1)
    await expect(readiness.wait('pty-1', 0, 1_000)).resolves.toBe(true)
  })

  it('waits for a fresh settlement when historical readiness is stale', async () => {
    const readiness = new RendererTerminalSerializerReadiness()
    readiness.markReady('pty-1')
    const pending = readiness.wait('pty-1', readiness.generation('pty-1'), 1_000)

    readiness.markReady('pty-1')

    await expect(pending).resolves.toBe(true)
    expect(readiness.generation('pty-1')).toBe(2)
  })

  it('releases waiters when the PTY is cleared', async () => {
    const readiness = new RendererTerminalSerializerReadiness()
    readiness.markReady('pty-1')
    const pending = readiness.wait('pty-1', readiness.generation('pty-1'), 1_000)

    readiness.clear('pty-1')

    await expect(pending).resolves.toBe(false)
    expect(readiness.has('pty-1')).toBe(false)
  })

  it('releases waiters on abort and timeout', async () => {
    vi.useFakeTimers()
    const readiness = new RendererTerminalSerializerReadiness()
    const abortController = new AbortController()
    const aborted = readiness.wait('pty-abort', 0, 1_000, abortController.signal)
    const timedOut = readiness.wait('pty-timeout', 0, 1_000)

    abortController.abort()
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(aborted).resolves.toBe(false)
    await expect(timedOut).resolves.toBe(false)
    vi.useRealTimers()
  })

  it('keeps a lifecycle waiter until readiness or abort when no timeout is supplied', async () => {
    vi.useFakeTimers()
    const readiness = new RendererTerminalSerializerReadiness()
    const abortController = new AbortController()
    const pending = readiness.wait('pty-lifecycle', 0, undefined, abortController.signal)

    await vi.advanceTimersByTimeAsync(60_000)
    abortController.abort()

    await expect(pending).resolves.toBe(false)
    vi.useRealTimers()
  })

  it('ignores late teardown from an older incarnation of a reused PTY id', async () => {
    const readiness = new RendererTerminalSerializerReadiness()
    const oldIncarnation = readiness.beginIncarnation('pty-reused')
    readiness.markReady('pty-reused')
    const priorGeneration = readiness.generation('pty-reused')

    readiness.beginIncarnation('pty-reused')
    const pending = readiness.wait('pty-reused', priorGeneration, 1_000)
    const oldTeardownCleared = readiness.clear('pty-reused', oldIncarnation)
    readiness.markReady('pty-reused')

    expect(oldTeardownCleared).toBe(false)
    await expect(pending).resolves.toBe(true)
    expect(readiness.has('pty-reused')).toBe(true)
  })
})
