import './mobile-agent-message-renderer.test-fixture'
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX } from '../../../../../src/shared/orca-dispatch-status-prompt'
import { agentMessageTranscriptText } from '../../../../../src/shared/agent-session/agent-message-display-text'
import {
  agentMessageHeading,
  agentMessageSenderLabel
} from '../../../../../src/shared/agent-session/agent-message-presentation'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'
import { findAllByHostType } from '../../../test-support/react-test-renderer-host-nodes'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))
let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})
const markdownIn = (node: ReactTestInstance): string[] =>
  node
    .findAll((child) => String(child.type) === 'MobileMarkdown')
    .map((markdown) => markdown.props.content)
const textIn = (node: ReactTestInstance): string[] =>
  findAllByHostType(node, 'Text').map((text) => String(text.children.join('')))

it.each(['started', 'task', 'coordinator', 'worker', 'generic'] as const)(
  'uses the desktop shared heading, sender, text and fold rules for %s',
  (kind) => {
    const from: AgentMessageSource = {
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_sender', terminalHandle: 'term_sender', orcaSessionId: null },
          name: 'Parser worker',
          ...(kind === 'coordinator' || kind === 'worker' ? { relation: kind } : {})
        }
      ],
      orchestration:
        kind === 'task'
          ? { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
          : { message: 'mail-notice', mailbox: 'term_recipient', dispatchId: null, messages: [] }
    }
    const body = 'A short task fits without a disclosure.'
    const raw =
      kind === 'task'
        ? `${ORCA_DISPATCH_STATUS_PREAMBLE_PREFIX}\r\nInstructions\r\n=== TASK ===\r\n${body}`
        : body
    const message: NativeChatMessage = {
      role: 'user',
      blocks: [{ type: 'text', text: raw }],
      timestamp: null,
      source: 'transcript',
      id: `notice-${kind}`,
      from,
      ...(kind === 'started' ? ({ role: 'system', agentStart: true } as const) : {})
    }
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message }))
    })
    const tree = renderer!
    const mailNotice = kind !== 'started' && kind !== 'task'
    if (mailNotice) {
      expect(textIn(tree.root)).toEqual(['Orchestration mail'])
      expect(markdownIn(tree.root)).toEqual([])
      const disclosure = findAllByHostType(tree.root, 'Pressable').find(
        (node) => node.props.accessibilityState?.expanded === false
      )!
      act(() => disclosure.props.onPress())
    }
    const headings = {
      started: 'Started worker',
      task: 'Task from coordinator',
      coordinator: 'Message from coordinator',
      worker: 'Update from worker',
      generic: 'Message from'
    }
    expect(textIn(tree.root).slice(mailNotice ? 1 : 0, mailNotice ? 3 : 2)).toEqual([
      headings[agentMessageHeading(from, message.agentStart === true)],
      agentMessageSenderLabel({
        localChat: false,
        snapshotName: from.senders[0].name,
        fallback: 'an agent'
      })
    ])
    expect(markdownIn(tree.root)).toEqual([agentMessageTranscriptText(message.blocks, from)])
  }
)
