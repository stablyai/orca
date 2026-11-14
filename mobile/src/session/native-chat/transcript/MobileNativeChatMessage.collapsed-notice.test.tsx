import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../../../../src/shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { createStructuredAgentSessionMessageProjection } from '../../../../../src/shared/agent-session/view/structured-agent-session-message-stream'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      Text,
      Value: class {
        setValue(): void {}
      },
      loop: (animation: unknown) => animation,
      sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
      timing: () => ({ start: vi.fn(), stop: vi.fn() })
    },
    Image: 'Image',
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 400, height: 800 })
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Bot: 'Bot',
  Brain: 'Brain',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  Copy: 'Copy',
  Eye: 'Eye',
  FileMinus2: 'FileMinus2',
  FilePen: 'FilePen',
  FilePlus2: 'FilePlus2',
  Folder: 'Folder',
  Globe: 'Globe',
  ListChecks: 'ListChecks',
  MessageSquareMore: 'MessageSquareMore',
  Pencil: 'Pencil',
  Plug: 'Plug',
  Search: 'Search',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench'
}))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('../../../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'CopyButton'
}))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { MobileNativeChatCollapsedNotice } from './MobileNativeChatCollapsedNotice'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import {
  MobileNativeChatDisclosureContext,
  useMobileNativeChatDisclosures
} from './mobile-native-chat-disclosure-store'

function item(itemId: string, body: AgentJournalRenderItem['body']): AgentJournalRenderItem {
  const sequence = Number(itemId.slice(1))
  return { itemId, revision: 1, sequence, observedAt: sequence, body }
}

function codexRetry(itemId: string): AgentJournalRenderItem {
  const head = `{"error":{"message":"stream disconnected ${itemId}"},"willRetry":true}`
  return item(itemId, {
    kind: 'status',
    tone: 'warning',
    ...agentSessionFailureWords(
      {
        kind: 'providerRetrying',
        detail: { text: `stream disconnected ${itemId}`, audience: 'person' }
      },
      { surface: 'row', agentName: 'Codex' }
    ),
    providerFrame: {
      provider: 'codex',
      kind: 'notification:error',
      payload: { head, byteLength: head.length, digest: 'synthetic', truncated: false }
    }
  })
}

const claudeRetry = item('c1', {
  kind: 'status',
  tone: 'warning',
  ...agentSessionFailureWords(
    {
      kind: 'providerRetrying',
      detail: { text: '{"type":"system","subtype":"api_retry"}', audience: 'log' },
      retry: { error: 'overloaded', status: 529, attempt: 2, maxRetries: 10 }
    },
    { surface: 'row', agentName: 'Claude' }
  )
})

const reply = (itemId: string): AgentJournalRenderItem =>
  item(itemId, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Partial answer' }]
  })

const project = createStructuredAgentSessionMessageProjection()

function Transcript({ items }: { items: AgentJournalRenderItem[] }) {
  const disclosures = useMobileNativeChatDisclosures('chat')
  return createElement(
    MobileNativeChatDisclosureContext.Provider,
    { value: disclosures },
    project(items, [], [])
      .filter((message) => message.role === 'system')
      .map((message) =>
        createElement(
          'Row',
          { key: message.id, id: message.id },
          createElement(MobileNativeChatMessage, { message, rowKey: message.id })
        )
      )
  )
}

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function draw(items: AgentJournalRenderItem[]): void {
  act(() => {
    const element = createElement(Transcript, { items })
    if (renderer) {
      renderer.update(element)
    } else {
      renderer = create(element)
    }
  })
}

function summary(id: string): ReactTestInstance {
  return renderer!.root
    .find((node) => String(node.type) === 'Row' && node.props.id === id)
    .find((node) => String(node.type) === 'Pressable')
}

function bodyText(id: string): string {
  return renderer!.root
    .find((node) => String(node.type) === 'Row' && node.props.id === id)
    .findAll((node) => String(node.type) === 'ScrollView')
    .flatMap((box) => box.findAll((node) => String(node.type) === 'Text'))
    .flatMap((node) => node.children.filter((part) => typeof part === 'string'))
    .join('')
}

it('keeps an opened retry row open through new attempts, older pages and trims that keep its attempt', () => {
  const [r1, r2, r3, r4, r6] = ['r1', 'r2', 'r3', 'r4', 'r6'].map(codexRetry)
  draw([r2!, r3!])
  expect(summary('r3').props['aria-expanded']).toBe(false)
  act(() => summary('r3').props.onPress())
  expect(summary('r3').props['aria-expanded']).toBe(true)

  draw([r1!, r2!, r3!])
  expect(summary('r3').props['aria-expanded']).toBe(true)

  draw([r1!, r2!, r3!, r4!])
  expect(summary('r4').props['aria-expanded']).toBe(true)
  expect(bodyText('r4')).toContain('Codex is retrying: stream disconnected r4.')

  draw([r3!, r4!])
  expect(summary('r4').props['aria-expanded']).toBe(true)

  draw([r3!, r4!, reply('r5'), r6!])
  expect(summary('r4').props['aria-expanded']).toBe(true)
  expect(summary('r6').props['aria-expanded']).toBe(false)

  // The attempt that held the choice is no longer loaded: the documented reset.
  draw([r4!])
  expect(summary('r4').props['aria-expanded']).toBe(false)
})

it('shows a retry with no provider frame as its own text once opened', () => {
  draw([claudeRetry])
  act(() => summary('c1').props.onPress())
  expect(bodyText('c1')).toBe(
    'Claude hit a temporary problem and is retrying. Retry 2 of 10.\nLast error: HTTP 529 overloaded.'
  )
})

it.each([
  [
    '  Codex is retrying: connection interrupted.  ',
    'connection interrupted',
    'Codex is retrying: connection interrupted.'
  ],
  ['Retry scheduled.', 'connection interrupted', 'Retry scheduled.\n\nconnection interrupted']
])(
  'shows distinct person-facing retry detail without repeating embedded detail',
  (text, detail, expected) => {
    act(() => {
      renderer = create(
        createElement(MobileNativeChatCollapsedNotice, {
          notice: {
            type: 'text',
            tone: 'warning',
            text,
            failure: { kind: 'providerRetrying', detail: { text: detail, audience: 'person' } }
          },
          look: { kind: 'collapsed-notice', label: 'retrying' },
          fontScale: 1
        })
      )
    })
    act(() => renderer!.root.find((node) => String(node.type) === 'Pressable').props.onPress())
    const body = renderer!.root
      .find((node) => String(node.type) === 'ScrollView')
      .findAll((node) => String(node.type) === 'Text')
      .flatMap((node) => node.children.filter((part) => typeof part === 'string'))
      .join('')
    expect(body.trim()).toBe(expected)
  }
)
