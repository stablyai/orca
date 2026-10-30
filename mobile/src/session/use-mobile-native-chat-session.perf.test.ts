import { useLayoutEffect, createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

it.each([10, 100])(
  'keeps terminal read ownership and committed state scoped across %i phone chats with equal portable IDs',
  async (count) => {
    const { messageQuestionFixture } =
      await import('../../../src/shared/message-question-occurrence.test-fixture')
    const states = new Map<number, MobileNativeChatSession>()
    const commits = new Map<number, number>()
    const callbacks = new Map<number, (frame: unknown) => void>()
    const versions = new Map<number, number>()
    const reads = new Map<number, number>()
    let opens = 0
    const session = (index: number) => `portable-${Math.floor(index / 2)}`
    const marker = (index: number) => ({
      contract: 'agent-session.current-requests.v2' as const,
      sessionId: session(index),
      epoch: 'portable-epoch',
      publisher: `host-${index % 2}`,
      revision: versions.get(index) ?? 1,
      owner: `host-${index % 2}:root`,
      version: `${session(index)}-${versions.get(index) ?? 1}`
    })
    const clients = Array.from({ length: count }, (_, index) => {
      const client = {
        sendRequest: vi.fn(async (method: string) => {
          expect(method).toBe('nativeChat.currentRequests')
          reads.set(index, (reads.get(index) ?? 0) + 1)
          return {
            ok: true,
            result: {
              marker: marker(index),
              nextCursor: null,
              json: JSON.stringify({
                blocking: [],
                asyncQuestions:
                  versions.get(index) === 2
                    ? null
                    : [messageQuestionFixture('equal-portable-question')],
                context: { sessionId: session(index), boundary: 'root' }
              })
            }
          }
        }),
        subscribe: vi.fn((_method: string, _params: unknown, onData: (frame: unknown) => void) => {
          opens++
          callbacks.set(index, onData)
          onData({ type: 'snapshot', messages: [], hasMore: false })
          return () => {
            callbacks.delete(index)
          }
        })
      }
      // SAFETY: this production hook only invokes the two RPC members supplied above.
      return client as unknown as RpcClient
    })
    function Probe({ index }: { index: number }): null {
      const state = useMobileNativeChatSession({
        client: clients[index],
        currentRequests: true,
        sourceIdentity: `host-${index % 2}\0workspace`,
        agent: 'codex',
        sessionId: session(index),
        transcriptPath: `/portable/${session(index)}`
      })
      states.set(index, state)
      useLayoutEffect(() => {
        commits.set(index, (commits.get(index) ?? 0) + 1)
      })
      return null
    }
    let renderer: ReactTestRenderer | undefined
    try {
      await act(async () => {
        renderer = create(
          createElement(
            'chats',
            null,
            ...Array.from({ length: count }, (_, index) =>
              createElement(Probe, { key: index, index })
            )
          )
        )
      })
      expect(callbacks.size).toBe(count)
      commits.clear()
      reads.clear()
      opens = 0
      const publish = async (index: number, revision: number) => {
        versions.set(index, revision)
        await act(async () =>
          callbacks.get(index)?.({ type: 'appended', messages: [], currentRequests: marker(index) })
        )
      }
      await publish(0, 1)
      expect(states.get(0)?.messageQuestions?.ready).toBe(true)
      expect(states.get(0)?.messageQuestions?.records).toHaveLength(1)
      expect(states.get(1)?.messageQuestions).toBeUndefined()
      expect([...commits.keys()]).toEqual([0])
      await publish(0, 2)
      expect(states.get(0)?.messageQuestions?.ready).toBe(false)
      expect(states.get(0)?.messageQuestions?.records).toHaveLength(1)
      commits.clear()
      reads.clear()
      for (let tick = 0; tick < 50; tick++) {
        await act(async () => {
          callbacks.get(0)?.({ type: 'appended', messages: [], currentRequests: marker(0) })
          callbacks.get(count - 1)?.({ type: 'appended', messages: [] })
        })
      }
      expect([...commits]).toEqual([])
      expect([...reads]).toEqual([])
      expect(opens).toBe(0)
      await publish(0, 3)
      expect(states.get(0)?.messageQuestions?.ready).toBe(true)
      expect([...commits.keys()]).toEqual([0])
      expect([...reads]).toEqual([[0, 1]])
      expect(opens).toBe(0)
    } finally {
      await act(async () => renderer?.unmount())
    }
    expect(callbacks.size).toBe(0)
  }
)
