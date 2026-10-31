import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalStatusItem } from '../../../../../src/shared/agent-session-journal-types'
import { isAdmissibleAgentJournalItemBody } from '../../../../../src/shared/agent-session-journal-schemas'
import { projectStructuredItemToNativeChat } from '../../../../../src/shared/structured-agent-session-projection'
import {
  NATIVE_CHAT_INTERRUPTED_STATUS_TEXT,
  type NativeChatMessage
} from '../../../../../src/shared/native-chat-types'
import {
  agentSessionFailureFact,
  readProviderRetry
} from '../../../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../src/shared/agent-session-failure-words'
import { colors } from '../../../theme/mobile-theme'
import { activateMobileUiLocale } from '../../../i18n/mobile-i18n'
import {
  MobileNativeChatNoticeContext,
  type MobileNativeChatNoticeNames
} from '../../mobile-native-chat-notice-context'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): unknown =>
    React.createElement('Text', props, children)
  return {
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
  AlertCircle: 'AlertCircle',
  AlertTriangle: 'AlertTriangle',
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
  Info: 'Info',
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
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'

describe('MobileNativeChatMessage status notices', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(async () => {
    act(() => renderer?.unmount())
    renderer = null
    await activateMobileUiLocale('en')
  })

  function render(message: NativeChatMessage): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message }))
    })
    return renderer!
  }

  const markdownIn = (node: ReactTestInstance): string[] =>
    node
      .findAll((child) => String(child.type) === 'MobileMarkdown')
      .map((markdown) => markdown.props.content)

  const statusRow = (body: AgentJournalStatusItem): NativeChatMessage =>
    projectStructuredItemToNativeChat({
      itemId: 'status',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body
    })!
  const renderNotice = (body: AgentJournalStatusItem, names: MobileNativeChatNoticeNames) => {
    act(() => {
      renderer = create(
        createElement(
          MobileNativeChatNoticeContext.Provider,
          { value: names },
          createElement(MobileNativeChatMessage, { message: statusRow(body) })
        )
      )
    })
    return renderer!.root.find(
      (node) => String(node.type) === 'Text' && node.props.selectable === true
    )
  }

  it('names the Orca host an Orca stop came from, in desktop words', () => {
    const text = renderNotice(
      {
        kind: 'status',
        text: 'Codex stopped while this response was in progress.',
        tone: 'error',
        presentation: 'orca-stop',
        orcaStop: { cause: 'quit' }
      },
      { hostName: 'MacBook Pro' }
    )
    expect(text.props.children).toBe(
      'Orca on MacBook Pro stopped while this response was in progress. You can continue in this conversation.'
    )
  })

  it.each(['without reset', 'with reset', 'from an old host'] as const)(
    'draws an OpenCode usage warning %s',
    (source) => {
      const hasReset = source === 'with reset'
      const resetsAt = new Date(2026, 9, 15, 15, 42).getTime()
      const now = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 9, 15, 12).getTime())
      try {
        const host = agentSessionFailureWords(
          agentSessionFailureFact('usageLimitReached', {
            detail: {
              text: 'Internal error: Rate limit exceeded. Please try again later.',
              audience: 'person'
            },
            ...(hasReset ? { usageLimit: { resetsAt } } : {})
          }),
          { surface: 'row', agentName: 'OpenCode' }
        )
        expect(host.text).toBe('OpenCode hit its usage limit.')
        const hostText =
          source === 'from an old host'
            ? 'OpenCode hit its usage limit. Send a message once it resets to continue.'
            : host.text
        const body: unknown = { kind: 'status', tone: 'warning', ...host, text: hostText }
        if (!isAdmissibleAgentJournalItemBody(body) || body.kind !== 'status') {
          throw new Error('Status fixture was not admitted')
        }
        const text = renderNotice(body, { hostName: null, agentName: 'OpenCode' })
        const tree = renderer!
        // An old host's stored advice gives way to desktop's sentence from the fact.
        expect(text.props.children).toEqual(
          hasReset
            ? expect.stringMatching(/^OpenCode hit its usage limit\. It resets at \S.*\.$/u)
            : 'OpenCode hit its usage limit.'
        )
        expect(Object.assign({}, ...text.props.style)).toMatchObject({ color: colors.statusAmber })
        expect(tree.root.find((node) => String(node.type) === 'AlertTriangle').props.color).toBe(
          colors.statusAmber
        )
        expect(markdownIn(tree.root)).toEqual([])
      } finally {
        now.mockRestore()
      }
    }
  )

  it.each<readonly [string, NativeChatMessage, string]>([
    [
      'an API retry as a warning',
      statusRow({
        kind: 'status',
        tone: 'warning',
        ...agentSessionFailureWords(
          agentSessionFailureFact('providerRetrying', {
            retry: readProviderRetry({
              error: 'overloaded',
              status: 529,
              attempt: 2,
              maxRetries: 10
            })
          }),
          { surface: 'row', agentName: 'Claude' }
        )
      }),
      colors.statusAmber
    ],
    [
      'a sign-in failure as an error',
      statusRow({
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
          agentName: 'Claude',
          provider: 'claude',
          surface: 'row'
        })
      }),
      colors.statusRed
    ],
    ...[
      'Please add or update your payment method to continue',
      'Your current subscription plan does not yet include access to glm-5'
    ].map(
      (instruction) =>
        [
          `an OpenCode corrective instruction: ${instruction}`,
          statusRow({ kind: 'status', tone: 'error', text: `Internal error: ${instruction}` }),
          colors.statusRed
        ] as const
    ),
    [
      'an interruption as a faint aside',
      {
        id: 'interrupted',
        role: 'system',
        blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
        timestamp: 1,
        source: 'transcript'
      } satisfies NativeChatMessage,
      colors.textMuted
    ]
  ])('draws %s, never as the agent speaking', (_, message, color) => {
    const tree = render(message)
    expect(tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')).toHaveLength(0)
    const text = tree.root.find(
      (node) => String(node.type) === 'Text' && node.props.selectable === true
    )
    expect(text.props.children).toBe(message.blocks.find((block) => block.type === 'text')?.text)
    expect(Object.assign({}, ...text.props.style)).toMatchObject({ color })
  })

  // Protocol-shaped synthetic frames, not a live-provider reproduction.
  it.each([
    [
      'codex',
      'notification:guardianWarning',
      'warning',
      'Codex reported a safety review warning. View details.',
      'Codex a signalé un avertissement de sécurité. Voir les détails.',
      colors.statusAmber
    ],
    [
      'claude',
      'message:system:permission_denied',
      'error',
      'Claude denied permission. View details.',
      'Claude a refusé la permission. Voir les détails.',
      colors.statusRed
    ]
  ] as const)(
    'discloses the entire available %s notice without tool-output clipping or recovery',
    async (provider, kind, tone, heading, french, color) => {
      const text = `${'安全 '.repeat(1500)}EXPLANATION_SENTINEL`
      const head = `{"partial":"${'é'.repeat(4500)}PAYLOAD_SENTINEL`
      const tree = render(
        statusRow({
          kind: 'status',
          text,
          tone,
          providerFrame: {
            provider,
            kind,
            payload: { head, byteLength: 99999, digest: 'synthetic', truncated: true }
          }
        })
      )
      const button = () =>
        tree.root.find(
          (node) =>
            String(node.type) === 'Pressable' &&
            node.props.accessibilityLabel?.includes('View details.')
        )
      expect(button().props.accessibilityLabel).toBe(heading)
      expect(button().props['aria-expanded']).toBe(false)
      const detailTexts = () =>
        tree.root.findAll(
          (node) =>
            String(node.type) === 'Text' &&
            node.props.selectable === true &&
            Array.isArray(node.props.children) &&
            node.props.children.includes(text)
        )
      expect(detailTexts()).toHaveLength(0)
      act(() => button().props.onPress())
      expect(button().props['aria-expanded']).toBe(true)
      const detail = detailTexts()[0]
      expect(detail.props.children.join('')).toContain(text)
      expect(detail.props.children.join('')).toContain(head)
      expect(detail.props.children.join('')).toContain(
        'Provider response truncated (original size: 99999 bytes).'
      )
      expect(Object.assign({}, ...detail.props.style)).toMatchObject({ color })
      expect(
        tree.root.findAll(
          (node) =>
            String(node.type) === 'Text' && String(node.props.children).includes('Show full output')
        )
      ).toHaveLength(0)
      await act(() => activateMobileUiLocale('fr'))
      const translated = tree.root.find(
        (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === french
      )
      expect(translated.props['aria-expanded']).toBe(true)
      expect(detailTexts()[0].props.children.join('')).toContain(
        'Réponse du fournisseur tronquée (taille d’origine : 99999 octets).'
      )
      act(() => translated.props.onPress())
      expect(detailTexts()).toHaveLength(0)
    }
  )

  it('draws a compaction as a divider, not as a reply', () => {
    const tree = render(
      statusRow({ kind: 'status', text: 'Context compacted', presentation: 'compaction' })
    )
    expect(tree.root.findAll((node) => String(node.type) === 'MobileMarkdown')).toHaveLength(0)
    expect(
      tree.root.findAll(
        (node) =>
          String(node.type) === 'View' && node.props.accessibilityLabel === 'Context compacted'
      )
    ).toHaveLength(1)
  })
})
