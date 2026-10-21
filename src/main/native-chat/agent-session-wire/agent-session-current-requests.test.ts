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
  const projection = { identity: 'host', items, marker }
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

it('retires positive owner changes, rejects late reads, and relinquishes authority on unsupported openings', async () => {
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
    expect(state.currentRequests).toEqual([])
    state = reduceStructuredAgentSession(state, {
      type: 'requests-complete',
      marker,
      items: [prompt]
    })
    expect(state.currentRequests).toEqual([])
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
    expect(state.currentRequests).toBeUndefined()
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
    expect(state.currentRequests).toBeUndefined()
  }
})
