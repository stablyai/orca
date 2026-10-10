import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pairToolBlocks } from '../../../src/shared/native-chat-tool-fold'
import { nativeChatTurnMembership } from '../../../src/shared/native-chat-turn-membership'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { foldMobileNativeChatMessages } from './mobile-native-chat-render-data'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

function message(
  id: string,
  blocks: NativeChatMessage['blocks'],
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage {
  return { id, role, blocks, timestamp: 1, source: 'transcript' }
}

function pairOutputs(rows: readonly NativeChatMessage[]): [string | undefined, string][] {
  return rows.flatMap((row) =>
    pairToolBlocks(row.blocks).flatMap((pair) => {
      if (!pair.result) {
        return []
      }
      const output: [string | undefined, string] = [pair.call?.callId, pair.result.output]
      return [output]
    })
  )
}

describe('mobile transcript tool result paging', () => {
  let renderer: ReactTestRenderer | null = null
  let session: MobileNativeChatSession | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    session = null
  })

  function current(): MobileNativeChatSession {
    if (!session) {
      throw new Error('session hook did not render')
    }
    return session
  }

  function Harness({ client }: { client: RpcClient }): null {
    session = useMobileNativeChatSession({
      client,
      sourceIdentity: 'ssh-host\0folder-workspace',
      agent: 'claude',
      sessionId: 'remote-session',
      transcriptPath: null
    })
    return null
  }

  it.each([true, false])(
    'restores exact ownership after an earlier read and reconnect (host cursors: %s)',
    async (hasCursor) => {
      const tail = [
        {
          ...message(
            'backlog',
            Array.from({ length: 2048 }, (_, index) => ({
              type: 'tool-call' as const,
              callId: `silent-${index}`,
              name: 'Bash',
              input: { command: `command ${index}` }
            }))
          ),
          transcriptOffset: 700
        },
        {
          ...message('source-results', [
            { type: 'tool-result', callId: 'outside-a', output: 'output A' },
            { type: 'tool-result', callId: 'silent-2047', output: 'late named output' },
            { type: 'tool-result', callId: 'outside-b', output: 'output B', isError: true }
          ]),
          transcriptOffset: 800
        }
      ]
      const older = [
        message('prompt', [{ type: 'text', text: 'original question' }], 'user'),
        message('older-calls', [
          { type: 'tool-call', callId: 'outside-a', name: 'Bash', input: 'A' },
          { type: 'tool-call', callId: 'outside-b', name: 'Bash', input: 'B' }
        ])
      ]
      let emit: (frame: unknown) => void = () => {}
      const sendRequest = vi.fn<RpcClient['sendRequest']>(async () => ({
        id: 'older-page',
        ok: true,
        result: {
          messages: hasCursor ? older : [...older, ...tail],
          hasMore: false,
          ...(hasCursor ? { beforeOffset: 0 } : {})
        }
      }))
      const client: RpcClient = {
        sendRequest,
        subscribe: (_method, _params, onData) => {
          emit = onData
          onData({
            type: 'snapshot',
            messages: structuredClone(tail),
            hasMore: true,
            ...(hasCursor ? { beforeOffset: 700 } : {})
          })
          return () => {}
        },
        updateTerminalSubscriptionViewport: () => {},
        getState: () => 'connected',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => 1,
        onStateChange: () => () => {},
        notifyForeground: () => {},
        close: () => {}
      }
      await act(async () => {
        renderer = create(createElement(Harness, { client }))
      })

      const windowed = foldMobileNativeChatMessages(current().messages)
      expect(pairOutputs(windowed)).toEqual([
        ['silent-2047', 'late named output'],
        [undefined, 'output A'],
        [undefined, 'output B']
      ])
      expect(windowed[1]).toMatchObject({
        id: 'source-results',
        role: 'tool',
        transcriptOffset: 800,
        blocks: [{ output: 'output A' }, { output: 'output B', isError: true }]
      })
      expect(foldMobileNativeChatMessages(windowed)).toEqual(windowed)
      expect(current().messages).toEqual(tail)
      expect(current().messages.every((row) => !Object.hasOwn(row, 'unpairedToolResults'))).toBe(
        true
      )

      await act(async () => {
        current().loadEarlier()
        await Promise.resolve()
      })
      expect(sendRequest).toHaveBeenCalledWith('nativeChat.readSession', {
        agent: 'claude',
        sessionId: 'remote-session',
        limit: hasCursor ? 60 : 100,
        ...(hasCursor ? { beforeOffset: 700 } : {})
      })
      expect(current().messages.map((row) => row.id)).toEqual([
        'prompt',
        'older-calls',
        'backlog',
        'source-results'
      ])
      const whole = foldMobileNativeChatMessages(current().messages)
      expect(pairOutputs(whole)).toEqual([
        ['outside-a', 'output A'],
        ['outside-b', 'output B'],
        ['silent-2047', 'late named output']
      ])
      expect(whole.some((row) => row.role === 'tool')).toBe(false)
      expect(nativeChatTurnMembership(whole).turnKeys).toEqual(['prompt', 'prompt'])
      expect(foldMobileNativeChatMessages(whole)).toEqual(whole)

      await act(async () => {
        emit({ type: 'snapshot', messages: structuredClone(tail), hasMore: true })
      })
      expect(foldMobileNativeChatMessages(current().messages)).toEqual(whole)
      expect(current().hasMore).toBe(false)
      expect(current().messages.every((row) => !Object.hasOwn(row, 'unpairedToolResults'))).toBe(
        true
      )
    }
  )
})
