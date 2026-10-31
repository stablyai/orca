import { afterEach, expect, it, vi } from 'vitest'
import { readMobileCurrentRequests } from './mobile-structured-agent-session-rpc'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcRequestFrame } from '../transport/rpc-envelope-fields'
import { createAgentSessionCurrentRequestsReader } from '../../../src/shared/agent-session-current-requests-reader'
import type { AgentSessionCurrentRequestsMarker } from '../../../src/shared/agent-session-current-requests-wire'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(
  [10, 100].flatMap((count) =>
    (['forward', 'reverse', 'expiry'] as const).map((order) => ({ count, order }))
  )
)(
  'withdraws a concurrently populated queue with bounded work and drains the actual slot: %o',
  async ({ count, order }) => {
    vi.useFakeTimers()
    const frames: RpcRequestFrame[] = []
    let sequence = 0
    const tracker = new RpcClientRequestTracker({
      nextId: () => String(++sequence),
      getState: () => 'connected',
      waitForConnected: async () => {},
      sendFrame: (frame) => {
        frames.push(frame)
        return true
      }
    })
    const sendRequest = vi.fn<RpcClient['sendRequest']>((method, params, options) =>
      tracker.sendRequest(method, params, options)
    )
    const client: RpcClient = {
      sendRequest,
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => tracker.rejectAll('closed')
    }
    const request = { sessionId: 'queue-chat', version: 'old', cursor: 0 }
    const controllers = Array.from({ length: count }, () => new AbortController())
    const signals = new Set(controllers.map((controller) => controller.signal))
    let enrolled = 0
    let detached = 0
    const add = AbortSignal.prototype.addEventListener
    const remove = AbortSignal.prototype.removeEventListener
    vi.spyOn(AbortSignal.prototype, 'addEventListener').mockImplementation(function (
      this: AbortSignal,
      ...args
    ) {
      if (signals.has(this) && args[0] === 'abort') {
        enrolled++
      }
      return add.apply(this, args)
    })
    vi.spyOn(AbortSignal.prototype, 'removeEventListener').mockImplementation(function (
      this: AbortSignal,
      ...args
    ) {
      if (signals.has(this) && args[0] === 'abort') {
        detached++
      }
      return remove.apply(this, args)
    })
    // Observe population handed to actual array searches, rather than timing or guessing engine shift cost.
    let searchedPopulation = 0
    const indexOf = Array.prototype.indexOf
    vi.spyOn(Array.prototype, 'indexOf').mockImplementation(function (
      this: unknown[],
      needle: unknown,
      from?: number
    ) {
      if (
        needle &&
        typeof needle === 'object' &&
        'deferred' in needle &&
        'options' in needle &&
        needle.options &&
        typeof needle.options === 'object' &&
        'key' in needle.options &&
        needle.options.key ===
          JSON.stringify(['agentSession.currentRequests', request.sessionId, null, null])
      ) {
        searchedPopulation += this.length
      }
      return indexOf.call(this, needle, from)
    })
    const all: Promise<unknown>[] = []
    const active = readMobileCurrentRequests(
      client,
      'host',
      'agentSession.currentRequests',
      request
    ).catch((error) => error)
    all.push(active)
    await vi.advanceTimersByTimeAsync(0)
    const withdrawn = controllers.map((controller, index) =>
      readMobileCurrentRequests(
        client,
        'host',
        'agentSession.currentRequests',
        {
          ...request,
          version: `obsolete-${index}`,
          cursor: index % 2 ? 24576 : 0
        },
        controller.signal
      ).catch((error) => error)
    )
    all.push(...withdrawn)
    expect(tracker.size()).toBe(1)
    expect(frames).toHaveLength(1)
    expect(enrolled).toBe(count)
    expect(detached).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    const survivors = [24576, 24576, 49152].map((cursor) => ({
      ...request,
      version: 'surviving',
      cursor
    }))
    const survivorResults = survivors.map((params) =>
      readMobileCurrentRequests(client, 'host', 'agentSession.currentRequests', params).catch(
        (error) => error
      )
    )
    all.push(...survivorResults)
    const marker: AgentSessionCurrentRequestsMarker = {
      contract: 'agent-session.current-requests.v2',
      sessionId: request.sessionId,
      epoch: 'epoch',
      publisher: 'publisher',
      revision: 2,
      owner: 'owner',
      version: 'current'
    }
    const payload = {
      blocking: [],
      asyncQuestions: [],
      context: { sessionId: request.sessionId, boundary: 'root' }
    }
    const complete = vi.fn()
    const errors = vi.fn()
    const reader = createAgentSessionCurrentRequestsReader({
      read: (piece, signal) =>
        readMobileCurrentRequests(client, 'host', 'agentSession.currentRequests', piece, signal),
      complete,
      error: errors,
      replaceMarker: vi.fn()
    })
    reader.observe(marker)
    const sibling = readMobileCurrentRequests(client, 'host', 'agentSession.currentRequests', {
      ...request,
      sessionId: 'other-chat'
    })
    all.push(sibling)
    await vi.advanceTimersByTimeAsync(0)
    expect(tracker.size()).toBe(2)
    expect(frames).toHaveLength(2)
    tracker.resolve({ id: frames[1].id, ok: true, result: { json: 'sibling' } })
    await expect(sibling).resolves.toEqual({ json: 'sibling' })
    try {
      if (order === 'expiry') {
        await vi.advanceTimersByTimeAsync(14_000)
      } else {
        const ordered = order === 'reverse' ? controllers.toReversed() : controllers
        for (const controller of ordered) {
          controller.abort(new Error('retired view'))
        }
        const retired = await Promise.all(withdrawn)
        expect(
          retired.every((error) => error instanceof Error && error.message === 'retired view')
        ).toBe(true)
        expect(frames).toHaveLength(2)
        expect(tracker.size()).toBe(1)
        tracker.resolve(
          order === 'reverse'
            ? {
                id: frames[0].id,
                ok: false,
                error: { code: 'read_failed', message: 'actual source failure' }
              }
            : { id: frames[0].id, ok: true, result: { json: 'old' } }
        )
        await vi.advanceTimersByTimeAsync(0)
      }
      if (order === 'expiry') {
        const expired = await Promise.all(withdrawn)
        expect(
          expired.every((error) => error instanceof Error && /timed out/.test(error.message))
        ).toBe(true)
      }
      expect(detached).toBe(count)
      expect(searchedPopulation).toBe(0)
      // Actual interest work is linear and is distinct from correlation/frame count below.
      expect(enrolled + detached).toBe(2 * count)
      for (let index = 0; index < survivors.length; index++) {
        expect(tracker.size()).toBe(1)
        const frame = frames[index + 2]
        expect(frame.params).toEqual(survivors[index])
        const options = sendRequest.mock.calls[index + 2][2]
        expect(options?.timeoutMs).toBe(order === 'expiry' ? 1_000 : 15_000)
        const result = { marker, json: `piece-${index}`, nextCursor: null }
        tracker.resolve(
          index === 1
            ? {
                id: frame.id,
                ok: false,
                error: { code: 'read_failed', message: 'middle piece failure' }
              }
            : { id: frame.id, ok: true, result }
        )
        await vi.advanceTimersByTimeAsync(0)
        if (index === 1) {
          expect(await survivorResults[index]).toBeInstanceOf(Error)
        } else {
          expect(await survivorResults[index]).toEqual(result)
        }
      }
      const current = frames[5]
      expect(current.params).toEqual({
        sessionId: marker.sessionId,
        version: marker.version,
        cursor: 0
      })
      tracker.resolve({
        id: current.id,
        ok: true,
        result: { marker, json: JSON.stringify(payload), nextCursor: null }
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(complete).toHaveBeenCalledExactlyOnceWith(marker, [], payload)
      expect(errors).not.toHaveBeenCalled()
      expect(tracker.size()).toBe(0)
      expect(frames).toHaveLength(6)
      expect(sendRequest).toHaveBeenCalledTimes(6)
      expect(frames.some((frame) => JSON.stringify(frame.params).includes('obsolete-'))).toBe(false)
      await Promise.all(all)
    } finally {
      reader.invalidate()
      client.close()
      await vi.advanceTimersByTimeAsync(15_000)
      await Promise.all(all)
      expect(tracker.size()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  }
)
