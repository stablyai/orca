import './mobile-agent-message-renderer.test-fixture'

import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'

import type { NativeChatResolvedPrompt } from '../../../../../src/shared/native-chat/native-chat-resolution-receipt'

import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'

import { MobileNativeChatMessage } from './MobileNativeChatMessage'

import { findAllByHostType } from '../../../test-support/react-test-renderer-host-nodes'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))

function userMessage(blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id: 'u1', role: 'user', blocks, timestamp: null, source: 'transcript' }
}

describe('MobileNativeChatMessage', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(
    message: NativeChatMessage,
    props: {
      fontScale?: number
      structuredActivityUi?: boolean
      activeTurnIsWorking?: boolean
      trailingRun?: boolean
      foldedAway?: boolean
      turnExpanded?: boolean
      turnStatus?: {
        startedAt: number | null
        thinking: boolean
        workedSeconds: number | null
      } | null
      onToggleTurn?: () => void
      reasoningIsLive?: boolean
      unsentNotice?: string
      receipt?: NativeChatResolvedPrompt
      userMessageOpen?: boolean
      onToggleUserMessage?: (messageId: string) => void
      awaiting?: boolean
    } = {}
  ): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message, ...props }))
    })
    return renderer!
  }

  const markdownIn = (node: ReactTestInstance): string[] =>
    node
      .findAll((child) => String(child.type) === 'MobileMarkdown')
      .map((markdown) => markdown.props.content)

  it.each(['task', 'generic'] as const)(
    'expands and refolds %s messages and preserves old-server body',
    (kind) => {
      const from: AgentMessageSource = {
        kind: 'agent',
        orchestration:
          kind === 'task' ? { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' } : null,
        senders: []
      }
      const message = {
        ...userMessage([
          { type: 'text' as const, text: 'Long paragraph wrapped over many native lines.' }
        ]),
        from
      }
      const tree = render(message)
      const toggle = () =>
        findAllByHostType(tree.root, 'Pressable').find(
          (node) => node.props.accessibilityState?.expanded !== undefined
        )!
      expect(markdownIn(tree.root)).toEqual([])
      expect(toggle().props.accessibilityState.expanded).toBe(false)
      act(() => toggle().props.onPress())
      expect(markdownIn(tree.root)).toEqual(['Long paragraph wrapped over many native lines.'])
      expect(toggle().props.accessibilityState.expanded).toBe(true)
      act(() => toggle().props.onPress())
      expect(markdownIn(tree.root)).toEqual([])
      act(() => tree.unmount())
      const oldServer = render({ ...message, from: undefined })
      expect(oldServer.root.findAllByProps({ testID: 'agent-message-card' })).toHaveLength(0)
      expect(markdownIn(oldServer.root)).toEqual([
        message.blocks[0].type === 'text' ? message.blocks[0].text : ''
      ])
    }
  )

  // An older host refuses the read; the row keeps today's placeholder.
})
