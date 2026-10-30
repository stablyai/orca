import { createElement, memo, useLayoutEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { useMobileStructuredAgentState } from './use-mobile-structured-agent-state'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import type { AgentSessionCurrentRequestsMarker } from '../../../src/shared/agent-session-current-requests-wire'
import type { MessageQuestionOccurrence } from '../../../src/shared/message-question-occurrence'
import { messageQuestionFixture } from '../../../src/shared/message-question-occurrence.test-fixture'
import * as requestState from '../../../src/shared/agent-session-current-requests'
import * as eventCoalescer from '../../../src/shared/structured-agent-session-coalescer'

const asyncStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

it.each([10, 100])(
  'isolates real structured phone state, source reads and card commits across %i mounted multi-host chats',
  async (count) => {
    const events = new Map<number, (event: AgentSessionSubscribeEvent) => void>()
    const states = new Map<number, ReturnType<typeof useMobileStructuredAgentState>['state']>()
    const commits = new Map<number, number>()
    const cardCommits = new Map<number, number>()
    const selections = new Map<number, number>()
    const revisions = new Map<number, number>()
    const sequences = new Map<number, number>()
    const increment = (map: Map<number, number>, index: number) =>
      map.set(index, (map.get(index) ?? 0) + 1)
    const id = (index: number) => `portable-${Math.floor(index / 2)}`
    const claim = (index: number): AgentSessionCurrentRequestsMarker => ({
      contract: 'agent-session.current-requests.v2',
      sessionId: id(index),
      epoch: 'phone-epoch',
      publisher: `phone-host-${index % 2}`,
      revision: revisions.get(index) ?? 1,
      owner: `phone-host-${index % 2}:canonical`,
      version: `phone-${index}-${revisions.get(index) ?? 1}`
    })
    const row = (name: string, sequence: number): AgentJournalRenderItem => ({
      itemId: name,
      revision: 1,
      sequence,
      observedAt: sequence,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: name }] }
    })
    const page = (index: number, sequence = 1): AgentSessionHistoryPage => ({
      sessionId: id(index),
      epoch: 'phone-epoch',
      direction: 'tail',
      items: [row(`phone-history-${index}-${sequence}`, sequence)],
      submissions: [],
      removedItemIds: [],
      hasOlder: false,
      hasNewer: false,
      window: { oldest: null, newest: null, nextCursor: { epoch: 'phone-epoch', sequence } }
    })
    let definitionsEncoded = 0
    const senders: ReturnType<typeof vi.fn>[] = []
    const releases = vi.fn()
    const clients = [0, 1].map((host) => {
      const indexFor = (params: { sessionId: string }) =>
        Number(params.sessionId.slice('portable-'.length)) * 2 + host
      const sendRequest = vi.fn(async (method: string, params: { sessionId: string }) => {
        const index = indexFor(params)
        if (method === 'agentSession.hold') {
          return { ok: true, result: {} }
        }
        if (method === 'agentSession.release') {
          releases(index)
          return { ok: true, result: {} }
        }
        if (method !== 'agentSession.currentRequests') {
          throw new Error(`Unexpected phone method: ${method}`)
        }
        definitionsEncoded++
        return {
          ok: true,
          result: {
            marker: claim(index),
            nextCursor: null,
            json: JSON.stringify({
              blocking: [],
              asyncQuestions: [
                messageQuestionFixture(`phone-question-${index}-${revisions.get(index) ?? 1}`)
              ],
              context: { sessionId: id(index), boundary: 'root' }
            })
          }
        }
      })
      senders.push(sendRequest)
      const subscribe = vi.fn(
        (_method: string, params: { sessionId: string }, emit: (event: unknown) => void) => {
          const index = indexFor(params)
          events.set(index, emit)
          emit({
            type: 'snapshot',
            sessionId: id(index),
            fence: 1,
            page: page(index),
            currentRequests: claim(index)
          })
          return () => {
            events.delete(index)
          }
        }
      )
      // SAFETY: this real hook uses only these public RpcClient request/subscription methods; unknown methods throw above.
      return { sendRequest, subscribe } as unknown as RpcClient
    })
    let dispatches = 0
    const originalCoalescer = eventCoalescer.createStructuredAgentSessionEventCoalescer
    vi.spyOn(eventCoalescer, 'createStructuredAgentSessionEventCoalescer').mockImplementation(
      (emit, delay) =>
        originalCoalescer((event) => {
          dispatches++
          emit(event)
        }, delay)
    )
    const projections = vi.spyOn(requestState, 'currentRequestsState')
    const Card = memo(function Card({
      index,
      records,
      ready
    }: {
      index: number
      records: readonly MessageQuestionOccurrence[]
      ready: boolean
    }) {
      useLayoutEffect(() => {
        increment(cardCommits, index)
      })
      return createElement('span', null, `${records[0]?.id}:${ready}`)
    })
    function PhoneState({ index }: { index: number }) {
      const { state } = useMobileStructuredAgentState({
        client: clients[index % 2],
        sessionId: id(index),
        sessionKey: `phone-host-${index % 2}\0${id(index)}`,
        enabled: true,
        connected: true
      })
      increment(selections, index)
      states.set(index, state)
      const view = requestState.currentMessageQuestionView(state)
      useLayoutEffect(() => {
        increment(commits, index)
      })
      return view ? createElement(Card, { index, records: view.records, ready: view.ready }) : null
    }
    let renderer: ReactTestRenderer | undefined
    const calls = () => senders.reduce((total, sender) => total + sender.mock.calls.length, 0)
    try {
      await act(async () => {
        renderer = create(
          createElement(
            'main',
            null,
            ...Array.from({ length: count }, (_, index) =>
              createElement(PhoneState, { index, key: index })
            )
          )
        )
      })
      await vi.waitFor(() =>
        expect(
          states.size === count &&
            [...states.values()].every(
              (state) => requestState.currentMessageQuestionView(state)?.ready
            )
        ).toBe(true)
      )
      expect(events.size).toBe(count)
      const baseline = { calls: calls(), definitionsEncoded }
      commits.clear()
      cardCommits.clear()
      selections.clear()
      projections.mockClear()
      dispatches = 0
      vi.useFakeTimers()
      // Each turn has a real other-host update plus duplicates; only that other chat should commit.
      for (let tick = 0; tick < 50; tick++) {
        await act(async () => {
          sequences.set(1, tick + 2)
          events.get(1)!({
            type: 'batch',
            sessionId: id(1),
            currentRequests: claim(1),
            batch: {
              cursor: { epoch: 'phone-epoch', sequence: tick + 2 },
              items: [row(`other-host-${tick}`, tick + 2)],
              removedItemIds: [],
              submissions: []
            }
          })
          events.forEach((emit, index) =>
            emit({
              type: 'batch',
              sessionId: id(index),
              currentRequests: claim(index),
              batch: {
                cursor: { epoch: 'phone-epoch', sequence: sequences.get(index) ?? 1 },
                items: [],
                removedItemIds: [],
                submissions: []
              }
            })
          )
          await vi.advanceTimersByTimeAsync(48)
        })
      }
      expect({ calls: calls(), definitionsEncoded }).toEqual(baseline)
      expect([...commits.keys()]).toEqual([1])
      expect([...cardCommits]).toEqual([])
      expect(dispatches).toBe(50 * count)
      expect(projections).toHaveBeenCalledTimes(50)
      commits.clear()
      selections.clear()
      projections.mockClear()
      for (let tick = 0; tick < 50; tick++) {
        await act(async () => {
          events.forEach((emit, index) =>
            emit({
              type: 'batch',
              sessionId: id(index),
              currentRequests: claim(index),
              batch: {
                cursor: { epoch: 'phone-epoch', sequence: sequences.get(index) ?? 1 },
                items: [],
                removedItemIds: [],
                submissions: []
              }
            })
          )
          await vi.advanceTimersByTimeAsync(48)
        })
      }
      expect([...commits]).toEqual([])
      // React may evaluate a same-state update without committing it; that work is counted separately.
      expect([...cardCommits]).toEqual([])
      expect(projections).not.toHaveBeenCalled()
      expect({ calls: calls(), definitionsEncoded }).toEqual(baseline)
      const duplicateHookEvaluations = [...selections.values()].reduce(
        (sum, value) => sum + value,
        0
      )
      for (const type of ['snapshot', 'reset'] as const) {
        const replacement = {
          sessionId: id(0),
          fence: 2,
          currentRequests: claim(0),
          page: page(0, 100)
        }
        await act(async () =>
          events.get(0)!(
            type === 'snapshot'
              ? { type, ...replacement }
              : { type, reset: 'epoch_changed', ...replacement }
          )
        )
        expect(states.get(0)?.items.map((item) => item.itemId)).toEqual(['phone-history-0-100'])
        expect(requestState.currentMessageQuestionView(states.get(0)!)?.ready).toBe(true)
        expect([...commits.keys()]).toEqual([0])
        expect([...cardCommits]).toEqual([])
      }
      commits.clear()
      selections.clear()
      revisions.set(0, 2)
      await act(async () => {
        events.get(0)!({
          type: 'batch',
          sessionId: id(0),
          currentRequests: claim(0),
          batch: {
            cursor: { epoch: 'phone-epoch', sequence: 100 },
            items: [],
            removedItemIds: [],
            submissions: []
          }
        })
        await vi.advanceTimersByTimeAsync(0)
      })
      expect([...commits.keys()]).toEqual([0])
      expect([...cardCommits.keys()]).toEqual([0])
      expect(calls()).toBe(baseline.calls + 1)
      expect(definitionsEncoded).toBe(baseline.definitionsEncoded + 1)
      expect(states.get(1)?.items.at(-1)?.itemId).toBe('other-host-49')
      console.log('structured-phone-ownership-counts', {
        count,
        duplicateDispatches: 50 * count,
        otherHostHistoryCompositions: 50,
        duplicateCompositions: 0,
        duplicateUpstreamCalls: 0,
        unaffectedCommits: 0,
        actualOwnRequestCalls: 1,
        definitionsEncoded,
        totalDispatches: dispatches,
        possibleDuplicateHookEvaluations: duplicateHookEvaluations
      })
    } finally {
      await act(async () => {
        renderer?.unmount()
        await Promise.resolve()
      })
      vi.useRealTimers()
      vi.restoreAllMocks()
      expect(events.size).toBe(0)
      expect(releases).toHaveBeenCalledTimes(count)
    }
  }
)
