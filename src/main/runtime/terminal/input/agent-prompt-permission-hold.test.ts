import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROMPT_PERMISSION_RECHECK_MS,
  waitWhileAgentPromptBlocked
} from './agent-prompt-permission-hold'

function hold(initiallyBlocked: boolean) {
  const state = { blocked: initiallyBlocked, stale: false }
  let wake: (() => void) | null = null
  let exit: (() => void) | null = null
  const released = { status: 0, exit: 0 }
  return {
    state,
    released,
    wake: () => wake?.(),
    exit: () => exit?.(),
    deps: {
      isBlocked: () => {
        if (state.stale) {
          throw new Error('terminal_handle_stale')
        }
        return state.blocked
      },
      subscribeStatus: (listener: () => void) => {
        wake = listener
        return () => {
          released.status += 1
        }
      },
      subscribeExit: (listener: () => void) => {
        exit = listener
        return () => {
          released.exit += 1
        }
      }
    }
  }
}

describe('waitWhileAgentPromptBlocked', () => {
  afterEach(() => vi.useRealTimers())

  it('resolves at once when nothing blocks, releasing its subscriptions', async () => {
    const h = hold(false)
    await expect(waitWhileAgentPromptBlocked(h.deps)).resolves.toBeUndefined()
    expect(h.released).toEqual({ status: 1, exit: 1 })
  })

  it('wakes on a status change without waiting for the recheck', async () => {
    vi.useFakeTimers()
    const h = hold(true)
    const waiting = waitWhileAgentPromptBlocked(h.deps)
    h.state.blocked = false
    h.wake()
    await expect(waiting).resolves.toBeUndefined()
    expect(h.released).toEqual({ status: 1, exit: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-reads on its timer for an answer no hook reports', async () => {
    vi.useFakeTimers()
    const h = hold(true)
    const waiting = waitWhileAgentPromptBlocked(h.deps)
    h.state.blocked = false
    await vi.advanceTimersByTimeAsync(AGENT_PROMPT_PERMISSION_RECHECK_MS)
    await expect(waiting).resolves.toBeUndefined()
  })

  it('rejects with the read error when the binding changes', async () => {
    const h = hold(true)
    const waiting = waitWhileAgentPromptBlocked(h.deps)
    h.state.stale = true
    h.wake()
    await expect(waiting).rejects.toThrow('terminal_handle_stale')
  })

  it('rejects on exit, including an exit already known at subscribe time', async () => {
    const h = hold(true)
    const waiting = waitWhileAgentPromptBlocked(h.deps)
    h.exit()
    await expect(waiting).rejects.toThrow('terminal_not_writable')

    await expect(
      waitWhileAgentPromptBlocked({
        ...h.deps,
        subscribeExit: (listener) => {
          listener()
          return () => {}
        }
      })
    ).rejects.toThrow('terminal_not_writable')
  })

  it('rejects on abort and clears its timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const h = hold(true)
    const waiting = waitWhileAgentPromptBlocked({ ...h.deps, signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toThrow('request_aborted')
    expect(vi.getTimerCount()).toBe(0)
    expect(h.released).toEqual({ status: 1, exit: 1 })
  })
})
