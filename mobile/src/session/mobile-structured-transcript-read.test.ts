import { expect, it, vi } from 'vitest'
import { startMobileStructuredTranscriptRead } from './mobile-structured-transcript-read'
import { AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY } from '../../../src/shared/agent-session-current-requests-capability'
import type { AgentSessionCurrentRequestsMarker } from '../../../src/shared/agent-session-current-requests-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../src/shared/structured-agent-session-reducer'

it.each([1, 2])(
  'reopens once after a rejected request and settles after %i failures',
  async (failures) => {
    const marker: AgentSessionCurrentRequestsMarker = {
      contract: AGENT_SESSION_CURRENT_REQUESTS_CLIENT_CAPABILITY,
      sessionId: 's',
      epoch: 'e',
      publisher: 'host',
      revision: 1,
      owner: 'host:1',
      version: 'v1'
    }
    const frame = {
      type: 'batch' as const,
      sessionId: 's',
      fence: 1,
      batch: { cursor: { epoch: 'e', sequence: 1 }, items: [], removedItemIds: [], submissions: [] }
    }
    let state: StructuredAgentSessionState = {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: 'e',
      cursor: frame.batch.cursor
    }
    const callbacks: ((raw: unknown) => void)[] = []
    const closes = [vi.fn(), vi.fn()]
    let calls = 0
    const read = vi.fn(async () => {
      if (++calls <= failures) {
        throw new Error('Read interrupted')
      }
      return { marker, json: '[]', nextCursor: null }
    })
    const stop = startMobileStructuredTranscriptRead({
      sessionId: 's',
      read,
      isCurrent: () => true,
      applyQueued: vi.fn(),
      open: (callback) => {
        callbacks.push(callback)
        return closes[callbacks.length - 1] ?? vi.fn()
      },
      apply: (action) => {
        state = reduceStructuredAgentSession(state, action)
      },
      error: () => {
        state = reduceStructuredAgentSession(state, { type: 'error', message: 'Read interrupted' })
      }
    })
    callbacks[0]?.({ ...frame, currentRequests: marker })
    await vi.waitFor(() => expect(callbacks).toHaveLength(2))
    expect(closes[0]).toHaveBeenCalledOnce()
    callbacks[0]?.(frame)
    expect(state.status).toBe('error')
    callbacks[1]?.({ ...frame, currentRequests: marker })
    if (failures === 1) {
      await vi.waitFor(() => expect(state.requestAuthority).toEqual(marker))
      expect(state.status).toBe('ready')
    } else {
      await vi.waitFor(() => expect(closes[1]).toHaveBeenCalledOnce())
      callbacks[1]?.(frame)
      expect(state.status).toBe('error')
      expect(state.requestAuthority).toBeUndefined()
    }
    expect(read).toHaveBeenCalledTimes(2)
    stop()
    callbacks[1]?.(frame)
    expect(read).toHaveBeenCalledTimes(2)
  }
)
