import { afterEach, expect, it, vi } from 'vitest'
import { readMobileCurrentRequests } from './mobile-structured-agent-session-rpc'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcRequestFrame } from '../transport/rpc-envelope-fields'
import { createAgentSessionCurrentRequestsReader } from '../../../src/shared/agent-session-current-requests-reader'
import type {
  AgentSessionCurrentRequestsMarker,
  CurrentRequestsPayload
} from '../../../src/shared/agent-session-current-requests-wire'
import { PENDING_MESSAGE_QUESTION } from '../../../src/shared/message-question-occurrence'

afterEach(() => vi.useRealTimers())

it.each(['agentSession.currentRequests', 'nativeChat.currentRequests'] as const)(
  'keeps unequal and equal immutable pieces and retired sibling signals separate through %s',
  async (method) => {
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
    const client: RpcClient = {
      sendRequest: (kind, params, options) => tracker.sendRequest(kind, params, options),
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => 1,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => tracker.rejectAll('closed')
    }
    const marker: AgentSessionCurrentRequestsMarker = {
      contract: 'agent-session.current-requests.v2',
      sessionId: 'shared-chat',
      epoch: 'epoch',
      publisher: 'publisher',
      revision: 1,
      owner: 'owner',
      version: 'same-version'
    }
    const payload: CurrentRequestsPayload = {
      blocking: [],
      context: { sessionId: marker.sessionId, boundary: 'original' },
      asyncQuestions: [
        {
          id: 'question',
          sourceId: 'source',
          context: 'original',
          sourceRowId: 'row',
          callSlot: 0,
          order: [1, 0],
          timestamp: null,
          turnId: null,
          responseMode: 'message',
          questions: [
            {
              question: 'Full question',
              multiSelect: false,
              options: [{ label: 'Unicode 🐬 '.repeat(10_000) }]
            }
          ],
          resolution: PENDING_MESSAGE_QUESTION
        }
      ]
    }
    const json = JSON.stringify(payload)
    const completed = [vi.fn(), vi.fn(), vi.fn()]
    const errors = vi.fn()
    const readers = completed.map((complete) =>
      createAgentSessionCurrentRequestsReader({
        read: (request, signal) =>
          readMobileCurrentRequests(
            client,
            'host',
            method,
            {
              ...request,
              ...(method === 'nativeChat.currentRequests'
                ? { agent: 'codex', transcriptPath: '/captured' }
                : {})
            },
            signal
          ),
        complete,
        error: errors,
        replaceMarker: vi.fn()
      })
    )
    let replied = 0
    const answer = async () => {
      const frame = frames[replied++]
      if (
        !frame ||
        !frame.params ||
        typeof frame.params !== 'object' ||
        !('cursor' in frame.params)
      ) {
        throw new Error('Expected an actual piece request')
      }
      const cursor = Number(frame.params.cursor)
      const end = Math.min(cursor + 24 * 1024, json.length)
      tracker.resolve({
        id: frame.id,
        ok: true,
        result: {
          marker,
          json: json.slice(cursor, end),
          nextCursor: end === json.length ? null : end
        }
      })
      await vi.advanceTimersByTimeAsync(0)
    }
    try {
      readers[0].observe(marker)
      await vi.advanceTimersByTimeAsync(0)
      await answer()
      expect(frames[1].params).toMatchObject({ cursor: 24576 })
      readers[1].observe(marker)
      await answer()
      expect(frames[2].params).toMatchObject({ cursor: 0 })
      // Reader A's next cursor is now queued; C must not overwrite it with cursor zero.
      readers[2].observe(marker)
      await answer()
      expect(frames[3].params).toMatchObject({ cursor: 49152 })
      expect(tracker.size()).toBe(1)
      // Bound the ordinary host replies by the known finite three-reader corpus.
      for (let i = 0; i < 3 * Math.ceil(json.length / (24 * 1024)) + 3 && tracker.size(); i++) {
        expect(tracker.size()).toBe(1)
        await answer()
      }
      for (const complete of completed) {
        expect(complete).toHaveBeenCalledOnce()
        expect(complete).toHaveBeenCalledWith(marker, [], payload)
      }
      expect(errors).not.toHaveBeenCalled()
      expect(tracker.size()).toBe(0)

      // Equal requests still own independent cancellation and expiry, with one actual slot.
      const request = { sessionId: marker.sessionId, version: marker.version, cursor: 0 }
      const active = readMobileCurrentRequests(client, 'host', method, request)
      void active.catch(() => {})
      const retired = new AbortController()
      const withdrawn = readMobileCurrentRequests(client, 'host', method, request, retired.signal)
      const rejected = expect(withdrawn).rejects.toThrow('view retired')
      const sibling = readMobileCurrentRequests(client, 'host', method, request)
      void sibling.catch(() => {})
      retired.abort(new Error('view retired'))
      await rejected
      await vi.advanceTimersByTimeAsync(0)
      expect(tracker.size()).toBe(1)
      await answer()
      await expect(active).resolves.toMatchObject({ marker })
      expect(tracker.size()).toBe(1)
      await answer()
      await expect(sibling).resolves.toMatchObject({ marker })
      expect(tracker.size()).toBe(0)
      expect(replied).toBe(frames.length)
    } finally {
      readers.forEach((reader) => reader.invalidate())
      client.close()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(tracker.size()).toBe(0)
    }
  }
)
