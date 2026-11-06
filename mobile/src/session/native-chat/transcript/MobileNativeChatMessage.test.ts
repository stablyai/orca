import './mobile-agent-message-renderer.test-fixture'

import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  NativeChatBackgroundTaskBlock,
  NativeChatMessage
} from '../../../../../src/shared/native-chat/native-chat-types'
import { backgroundTaskJournalBody } from '../../../../../src/shared/native-chat/input/native-chat-background-task-row'
import { projectStructuredItemToNativeChat } from '../../../../../src/shared/agent-session/view/structured-agent-session-projection'

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
  const textIn = (node: ReactTestInstance): string[] =>
    findAllByHostType(node, 'Text').map((text) => String(text.children.join('')))

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

  it('draws a background task as its row, not the plain sentence written for older clients', () => {
    const task = (overrides: Partial<NativeChatBackgroundTaskBlock>): NativeChatMessage =>
      projectStructuredItemToNativeChat({
        itemId: 'task',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: backgroundTaskJournalBody({
          type: 'background-task',
          taskId: 'b1',
          kind: 'command',
          label: 'pnpm test',
          state: 'working',
          startedAt: 1_000,
          outputFile: '/tmp/b1.output',
          ...overrides
        })
      })!
    const run = () => render(task({})).root.findByProps({ testID: 'background-task-run' })
    expect(textIn(run())).toEqual(['pnpm test', 'working', 'Output: /tmp/b1.output'])
    act(() => renderer?.unmount())
    const settled = render(
      task({ state: 'blocked', settledAt: 66_000, summary: 'Exited with code 1' })
    )
    expect(textIn(settled.root)).toEqual([
      'pnpm test',
      'blocked · failed · 1m 5s',
      'Exited with code 1',
      'Output: /tmp/b1.output'
    ])
  })
})
