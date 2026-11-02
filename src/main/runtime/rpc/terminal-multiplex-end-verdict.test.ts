import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'

type ControlledWait = {
  promise: Promise<RuntimeTerminalWait>
  reject: (error: Error) => void
  resolve: (result: RuntimeTerminalWait) => void
}

function createControlledWait(): ControlledWait {
  let resolve = (_result: RuntimeTerminalWait): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<RuntimeTerminalWait>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

async function startSubscribedTerminal(wait: ControlledWait) {
  const harness = startDesktopMultiplexSubscribe({
    waitForTerminal: vi.fn(() => wait.promise)
  })
  await vi.waitFor(() =>
    expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
      true
    )
  )
  sendDesktopMultiplexSubscribe(harness.handlers)
  await vi.waitFor(() => expect(harness.runtime.waitForTerminal).toHaveBeenCalled())
  return harness
}

function endEvents(messages: string[]): unknown[] {
  return messages
    .map((message) => JSON.parse(message).result)
    .filter((result) => result?.type === 'end')
}

describe('terminal multiplex end verdict', () => {
  it('reports exited only when the owning runtime completes the exit waiter', async () => {
    const wait = createControlledWait()
    const harness = await startSubscribedTerminal(wait)

    wait.resolve({
      handle: 'terminal-1',
      condition: 'exit',
      satisfied: true,
      status: 'exited',
      exitCode: 0
    })

    await vi.waitFor(() =>
      expect(endEvents(harness.messages)).toContainEqual({
        type: 'end',
        streamId: 7,
        verdict: 'exited'
      })
    )
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('reports unverifiable when the runtime cannot observe the exit waiter', async () => {
    const wait = createControlledWait()
    const harness = await startSubscribedTerminal(wait)

    wait.reject(new Error('stale terminal handle'))

    await vi.waitFor(() =>
      expect(endEvents(harness.messages)).toContainEqual({
        type: 'end',
        streamId: 7,
        verdict: 'unverifiable'
      })
    )
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('reports unverifiable when a disconnected PTY resolves with unknown liveness', async () => {
    const wait = createControlledWait()
    const harness = await startSubscribedTerminal(wait)

    wait.resolve({
      handle: 'terminal-1',
      condition: 'exit',
      satisfied: true,
      status: 'unknown',
      exitCode: null
    })

    await vi.waitFor(() =>
      expect(endEvents(harness.messages)).toContainEqual({
        type: 'end',
        streamId: 7,
        verdict: 'unverifiable'
      })
    )
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })
})
