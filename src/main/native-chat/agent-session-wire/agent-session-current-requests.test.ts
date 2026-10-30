import type { MessageQuestionOccurrence } from '../../../shared/message-question-occurrence'
import { expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { createAgentSessionCurrentRequestsReader } from '../../../shared/agent-session-current-requests-reader'
import type {
  AgentSessionCurrentRequestsMarker,
  AgentSessionCurrentRequestsPiece
} from '../../../shared/agent-session-current-requests-wire'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../../shared/agent-session-current-requests-capability'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../shared/structured-agent-session-reducer'
import { readCurrentRequestsPiece } from './agent-session-current-requests'
import {
  hasCompleteBlockingRequests,
  selectAgentSessionCurrentRequests
} from '../../../shared/agent-session-current-requests'

const marker: AgentSessionCurrentRequestsMarker = {
  contract: AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
  publisher: 'host',
  revision: 1,
  sessionId: 's',
  epoch: 'e',
  owner: 'host:fence-1',
  version: 'v1'
}
const prompt: AgentJournalRenderItem = {
  itemId: 'child',
  revision: 1,
  sequence: 1,
  observedAt: 10,
  body: {
    kind: 'approval',
    title: 'Inspect?',
    detail: '\\"😀'.repeat(800_000),
    options: [{ id: 'yes', label: 'Allow' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}

it('pulls a greater-than-frame record and greater-than-window collection losslessly with one piece in flight', async () => {
  const items = [prompt]
  const projection = { identity: 'host', items, marker, json: JSON.stringify(items) }
  let inFlight = 0
  let maximum = 0
  const complete = vi.fn()
  const error = vi.fn()
  const reader = createAgentSessionCurrentRequestsReader({
    read: async (request) => {
      maximum = Math.max(maximum, ++inFlight)
      await Promise.resolve()
      const piece = readCurrentRequestsPiece(projection, request)
      expect(Buffer.byteLength(JSON.stringify({ id: 'rpc', result: piece }))).toBeLessThan(
        200 * 1024
      )
      inFlight--
      return piece
    },
    complete,
    error,
    replaceMarker: vi.fn()
  })
  reader.observe(marker)
  await vi.waitFor(() => expect(complete).toHaveBeenCalledWith(marker, items))
  expect(maximum).toBe(1)
  expect(error).not.toHaveBeenCalled()
  reader.invalidate()
})

it('rejects late reads, retains established controls disabled on marker-less reconnect and admits initial legacy history', async () => {
  let resolve: ((piece: AgentSessionCurrentRequestsPiece) => void) | undefined
  const complete = vi.fn()
  const reader = createAgentSessionCurrentRequestsReader({
    read: () =>
      new Promise((done) => {
        resolve = done
      }),
    complete,
    replaceMarker: vi.fn(),
    error: vi.fn()
  })
  reader.observe(marker)
  reader.invalidate()
  resolve?.({ marker, json: JSON.stringify([]), nextCursor: null })
  await Promise.resolve()
  expect(complete).not.toHaveBeenCalled()
  for (const items of [[], [prompt]]) {
    let state: StructuredAgentSessionState = {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'e',
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      items: [prompt],
      currentRequests: items,
      requestMarker: marker,
      requestAuthority: marker
    }
    const replacement = { ...marker, owner: 'host:fence-2', version: 'v2', revision: 2 }
    state = reduceStructuredAgentSession(state, { type: 'requests-marker', marker: replacement })
    expect(state.currentRequests).toBe(items)
    expect(hasCompleteBlockingRequests(state)).toBe(false)
    state = reduceStructuredAgentSession(state, {
      type: 'requests-complete',
      marker,
      items: [prompt]
    })
    expect(state.currentRequests).toBe(items)
    expect(state.requestAuthority).toBe(marker)
    const batch = {
      type: 'batch' as const,
      sessionId: 's',
      fence: 2,
      batch: { cursor: { epoch: 'e', sequence: 1 }, items: [], removedItemIds: [], submissions: [] }
    }
    state = reduceStructuredAgentSession(state, {
      type: 'event',
      event: batch,
      opensSubscription: true
    })
    expect(state.currentRequests).toBe(items)
    expect(state.requestMarker).toBe(replacement)
    expect(state.requestAuthority).toBeUndefined()
    state = reduceStructuredAgentSession(state, { type: 'requests-marker', marker: replacement })
    state = reduceStructuredAgentSession(state, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 's',
        fence: 2,
        page: {
          sessionId: 's',
          epoch: 'e',
          direction: 'tail',
          items: [prompt],
          removedItemIds: [],
          submissions: [],
          hasOlder: false,
          hasNewer: false,
          window: { oldest: null, newest: null, nextCursor: { epoch: 'e', sequence: 1 } }
        }
      }
    })
    expect(state.currentRequests).toBe(items)
    expect(state.requestMarker).toBe(replacement)
    expect(hasCompleteBlockingRequests(state)).toBe(false)
    const legacy = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: {
        type: 'snapshot',
        sessionId: 's',
        fence: 2,
        page: {
          sessionId: 's',
          epoch: 'e',
          direction: 'tail',
          items: [prompt],
          removedItemIds: [],
          submissions: [],
          hasOlder: false,
          hasNewer: false,
          window: { oldest: null, newest: null, nextCursor: { epoch: 'e', sequence: 1 } }
        }
      }
    })
    expect(legacy.currentRequests).toBeUndefined()
    expect(legacy.requestMarker).toBeUndefined()
    expect(selectAgentSessionCurrentRequests(legacy)).toEqual([prompt])
  }
})

it('negotiates lossless message-answerable controls separately from v1 callbacks and installs restarted reads atomically', async () => {
  const v2 = { ...marker, contract: 'agent-session.current-requests.v2' as const }
  const question: MessageQuestionOccurrence = {
    id: 'question-1',
    sourceId: 'source-1',
    context: 'context',
    callSlot: 0,
    order: [1, 0],
    turnId: null,
    resolution: {
      state: 'pending',
      reason: null,
      factId: null,
      resolvedBy: null,
      resolvedAt: null
    } as const,
    sourceRowId: 'outside-history',
    timestamp: 10,
    responseMode: 'message' as const,
    questions: [
      {
        header: 'Choose',
        question: 'Which?',
        multiSelect: false,
        options: [{ label: 'Blue', description: '\\"😀'.repeat(20_000) }]
      }
    ]
  }
  const payload = {
    blocking: [prompt],
    asyncQuestions: [question],
    context: { sessionId: 's', boundary: 'context' }
  }
  let current = { identity: 'host', items: payload, marker: v2, json: JSON.stringify(payload) }
  const complete = vi.fn()
  const error = vi.fn()
  let reads = 0
  const reader = createAgentSessionCurrentRequestsReader({
    read: async (request) => {
      reads++
      if (reads === 2) {
        current = {
          identity: 'host',
          marker: { ...v2, version: 'replacement', revision: 2 },
          items: { ...payload, asyncQuestions: [] },
          json: JSON.stringify({ ...payload, asyncQuestions: [] })
        }
      }
      return readCurrentRequestsPiece(current, request)
    },
    complete,
    replaceMarker: vi.fn(),
    error
  })
  reader.observe(v2)
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce())
  expect(complete).toHaveBeenCalledWith(current.marker, [prompt], current.items)
  expect(reads).toBeGreaterThan(3)
  expect(error).not.toHaveBeenCalled()
  reader.invalidate()
  const legacyComplete = vi.fn()
  const legacyError = vi.fn()
  const legacy = createAgentSessionCurrentRequestsReader({
    read: async () => ({ marker, json: JSON.stringify(payload), nextCursor: null }),
    complete: legacyComplete,
    replaceMarker: vi.fn(),
    error: legacyError
  })
  legacy.observe(marker)
  await vi.waitFor(() => expect(legacyError).toHaveBeenCalledOnce())
  expect(legacyComplete).not.toHaveBeenCalled()
  legacy.invalidate()
})

it.each([10, 100])(
  'coalesces %i supersessions while an uncancellable actual read drains finitely without overlap',
  async (count) => {
    vi.useFakeTimers()
    let reads = 0
    let active = 0
    let maximum = 0
    let oldSignal: AbortSignal | undefined
    const complete = vi.fn()
    const error = vi.fn()
    const reader = createAgentSessionCurrentRequestsReader({
      read: async (request, signal) => {
        maximum = Math.max(maximum, ++active)
        try {
          if (++reads === 1) {
            oldSignal = signal
            await new Promise((resolve) => setTimeout(resolve, 15_000))
            return { marker, json: '[]', nextCursor: null }
          }
          return {
            marker: { ...marker, version: request.version, revision: count + 1 },
            json: '[]',
            nextCursor: null
          }
        } finally {
          active--
        }
      },
      complete,
      error,
      replaceMarker: vi.fn()
    })
    try {
      reader.observe(marker)
      let next = marker
      for (let index = 1; index <= count; index++) {
        reader.invalidate()
        next = { ...marker, version: `v${index + 1}`, revision: index + 1 }
        reader.observe(next)
        expect(active).toBe(1)
        expect(reads).toBe(1)
      }
      expect(oldSignal?.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(14_999)
      expect(active).toBe(1)
      expect(complete).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(complete).toHaveBeenCalledExactlyOnceWith(next, [])
      expect({ reads, active, maximum }).toEqual({ reads: 2, active: 0, maximum: 1 })
      expect(error).not.toHaveBeenCalled()
    } finally {
      reader.invalidate()
      vi.useRealTimers()
    }
  }
)

it('retries a timed-out piece through the existing backoff and completes after a legitimate transport wake', async () => {
  vi.useFakeTimers()
  const complete = vi.fn()
  let calls = 0
  let active = 0
  let maximum = 0
  let signal: AbortSignal | undefined
  const error = vi.fn()
  const reader = createAgentSessionCurrentRequestsReader({
    read: async (_request, ownedSignal) => {
      maximum = Math.max(maximum, ++active)
      try {
        if (++calls === 1) {
          signal = ownedSignal
          await new Promise<void>((_resolve, reject) => {
            ownedSignal.addEventListener('abort', () => reject(ownedSignal.reason), { once: true })
          })
        }
        return { marker, json: '[]', nextCursor: null }
      } finally {
        active--
      }
    },
    complete,
    error,
    replaceMarker: vi.fn()
  })
  try {
    reader.observe(marker)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(signal?.aborted).toBe(true)
    expect({ calls, active, maximum }).toEqual({ calls: 1, active: 0, maximum: 1 })
    expect(complete).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(749)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(complete).toHaveBeenCalledExactlyOnceWith(marker, [])
    expect({ calls, active, maximum }).toEqual({ calls: 2, active: 0, maximum: 1 })
    expect(error).not.toHaveBeenCalled()
  } finally {
    reader.invalidate()
    vi.useRealTimers()
  }
})
