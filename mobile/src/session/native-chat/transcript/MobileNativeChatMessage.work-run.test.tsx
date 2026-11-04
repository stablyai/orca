import { mobileI18n, activateMobileUiLocale } from '../../../i18n/mobile-i18n'
import fr from '../../../i18n/locales/fr.json'
import {
  readMobileNativeChatItem,
  MobileNativeChatItemSourceContext
} from '../mobile-native-chat-item-read'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'
import { projectStructuredItemToNativeChat } from '../../../../../src/shared/agent-session/view/structured-agent-session-projection'
import { mailReportPresentation } from '../../../../../src/shared/agent-session/mail-report-presentation'
import { orchestrationMailFixture } from '../../../../../src/shared/agent-session/orchestration-mail.test-fixture'
import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { RpcClient } from '../../../transport/rpc-client'
import { useMobileNativeChatMessageDetail } from './use-mobile-native-chat-message-detail'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    Animated: {
      Text,
      Value: class {
        setValue(): void {}
      }
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
  Bot: 'Bot',
  Brain: 'Brain',
  Check: 'Check',
  ChevronRight: 'ChevronRight',
  Circle: 'Circle',
  CircleCheck: 'CircleCheck',
  CircleDot: 'CircleDot',
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
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench'
}))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('../../../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'CopyButton'
}))
vi.mock('../../../components/inline-text-selection', () => ({ INLINE_TEXT_SELECTION: false }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { nativeChatReasoningDisclosureKey } from '../../../../../src/shared/native-chat/transcript/native-chat-reasoning-row'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'

const thought: NativeChatMessage = {
  id: 'r1',
  role: 'reasoning',
  state: 'completed',
  completedAt: 2_000,
  blocks: [{ type: 'text', text: 'Which file holds the fold?' }],
  timestamp: 0,
  source: 'transcript'
}
const read: NativeChatMessage = {
  id: 'a1',
  role: 'assistant',
  blocks: [
    { type: 'tool-call', name: 'Read', input: { file_path: 'src/a.ts' }, state: 'completed' }
  ],
  timestamp: 0,
  source: 'transcript'
}
const command: NativeChatMessage = {
  id: 'a2',
  role: 'assistant',
  blocks: [
    { type: 'tool-call', name: 'Bash', input: { command: 'pnpm test' }, state: 'completed' }
  ],
  timestamp: 0,
  source: 'transcript'
}

let renderer: ReactTestRenderer | null = null
afterEach(async () => {
  act(() => renderer?.unmount())
  renderer = null
  await activateMobileUiLocale('en')
  mobileI18n.removeResourceBundle('fr', 'translation')
})

const textIn = (node: ReactTestInstance): string[] =>
  node.findAll((child) => String(child.type) === 'Text').map((text) => text.children.join(''))

it('loads a shortened grouped thought from its own source between two tool rows', async () => {
  const fullText = 'x'.repeat(99_991) + 'FULL TAIL'
  const shortened: NativeChatMessage = {
    ...thought,
    shortened: true,
    blocks: [{ type: 'text', text: fullText.slice(0, 70_000) }]
  }
  const item: AgentJournalRenderItem = {
    itemId: thought.id,
    sequence: 1,
    revision: 2,
    observedAt: 2_000,
    body: {
      kind: 'message',
      role: 'reasoning',
      state: 'completed',
      completedAt: 2_000,
      blocks: [{ type: 'text', text: fullText }]
    }
  }
  const sendRequest = vi.fn(async () => ({ id: 'detail', ok: true as const, result: { item } }))
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => 0,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const source = { client, sessionId: 'session' }
  const messages = [read, shortened, command]
  function Transcript() {
    const detail = useMobileNativeChatMessageDetail(messages, source)
    return createElement(
      MobileNativeChatItemSourceContext.Provider,
      { value: { ...source, messageDetail: detail.detail } },
      createElement(MobileNativeChatMessage, {
        message: read,
        workRun: detail.messages,
        openReasoning: new Set([nativeChatReasoningDisclosureKey(thought.id)]),
        onToggleReasoning: vi.fn(),
        structuredActivityUi: true,
        activeTurnIsWorking: false
      })
    )
  }
  await act(async () => {
    renderer = create(createElement(Transcript))
  })
  const tree = renderer!
  act(() =>
    tree.root
      .find((node) => String(node.type) === 'Pressable' && node.props.accessibilityLiveRegion)
      .props.onPress()
  )
  expect(textIn(tree.root)).toContain('Read 1 file and ran 1 command')
  const showFull = tree.root.find(
    (node) =>
      String(node.type) === 'Pressable' &&
      node.props.accessibilityRole === 'button' &&
      textIn(node).includes('Show full message')
  )
  await act(async () => {
    showFull.props.onPress()
  })
  expect(sendRequest).toHaveBeenCalledExactlyOnceWith(
    'agentSession.item',
    { sessionId: source.sessionId, itemId: thought.id },
    expect.any(Object)
  )
  const markdown = tree.root.find((node) => String(node.type) === 'MobileMarkdown')
  expect(markdown.props.content).toBe(fullText)
  expect(textIn(tree.root)).not.toContain('Show full message')
  expect(textIn(tree.root)).toEqual(expect.arrayContaining(['Read', 'a.ts', 'pnpm test']))
})

it('keeps an exact command report on the phone full-item read', async () => {
  const message = orchestrationMailFixture()
  const mail = message.from.orchestration
  if (mail?.message !== 'mail-notice') {
    throw new Error('fixture')
  }
  const item: AgentJournalRenderItem = {
    itemId: 'full',
    sequence: 1,
    revision: 2,
    observedAt: 0,
    body: { kind: 'message', role: 'user', blocks: message.blocks, from: message.from }
  }
  const ref = mail.messages[0]!
  const fact = {
    itemId: item.itemId,
    mailbox: mail.mailbox,
    messageId: ref.messageId,
    runId: ref.runId,
    from: ref.from,
    report: { version: 1, kind: 'command', result: { type: 'exit', code: 7 } }
  }
  const client = stubRpcClient({
    sendRequest: vi.fn(async () => ({
      id: 'detail',
      ok: true as const,
      result: { item, mailDisplayReports: { version: 1, entries: [fact] } }
    }))
  })
  const loaded = await readMobileNativeChatItem({ client, sessionId: 'session' }, item.itemId)
  expect(mailReportPresentation(projectStructuredItemToNativeChat(loaded!)!)).toMatchObject({
    kind: 'command-report',
    report: { result: { type: 'exit', code: 7 } }
  })
  expect(loaded).toEqual(item)
})

it('shows a localized observed result in the phone background report surface', async () => {
  mobileI18n.addResourceBundle('fr', 'translation', fr)
  await activateMobileUiLocale('fr')
  const message = orchestrationMailFixture()
  const mail = message.from.orchestration
  if (mail?.message !== 'mail-notice') {
    throw new Error('fixture')
  }
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatMessage, {
        message: {
          ...message,
          mailDisplayReports: [
            {
              ...mail.messages[0]!,
              mailbox: mail.mailbox,
              report: { version: 1, kind: 'command', result: { type: 'exit', code: 7 } }
            }
          ]
        }
      })
    )
  })
  expect(textIn(renderer!.root)).toContain('Code de sortie 7')
  expect(textIn(renderer!.root)).not.toContain('an agent')
})
