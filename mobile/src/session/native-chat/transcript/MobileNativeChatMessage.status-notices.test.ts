import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalStatusItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { isAdmissibleAgentJournalItemBody } from '../../../../../src/shared/agent-session/journal/agent-session-journal-schemas'
import { projectStructuredItemToNativeChat } from '../../../../../src/shared/agent-session/view/structured-agent-session-projection'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { agentSessionFailureFact } from '../../../../../src/shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../src/shared/agent-session/failures/agent-session-failure-words'
import { colors } from '../../../theme/mobile-theme'
import { activateMobileUiLocale } from '../../../i18n/mobile-i18n'
import { MarkdownLinkHandlerContext } from '../../../components/markdown-link-handler'
import {
  MobileNativeChatNoticeContext,
  type MobileNativeChatNoticeView
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
  CircleCheck: 'CircleCheck',
  CircleX: 'CircleX',
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

  const statusRow = (body: AgentJournalStatusItem): NativeChatMessage =>
    projectStructuredItemToNativeChat({
      itemId: 'status',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body
    })!
  const renderNotice = (body: AgentJournalStatusItem, names: MobileNativeChatNoticeView) => {
    act(() => {
      renderer = create(
        createElement(
          MobileNativeChatNoticeContext.Provider,
          { value: names },
          createElement(MobileNativeChatMessage, { message: statusRow(body) })
        )
      )
    })
    return renderer!.root.findAll(
      (node) => String(node.type) === 'Text' && node.props.selectable === true
    )[0]!
  }

  it('localizes a canonical failure and discloses its diagnostic only on request', async () => {
    await activateMobileUiLocale('fr')
    const diagnostic = 'Internal provider diagnostic: modelNotFound'
    const notice = renderNotice(
      {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(agentSessionFailureFact('modelUnavailable'), {
          agentName: 'Codex',
          surface: 'row'
        }),
        providerFrame: {
          provider: 'codex',
          kind: 'notification:error',
          payload: {
            head: diagnostic,
            byteLength: diagnostic.length,
            digest: 'fixture',
            truncated: false
          }
        }
      },
      { hostName: null, agentName: 'Codex' }
    )
    expect(String(notice.props.children)).toContain('le modèle sélectionné')
    expect(String(notice.props.children)).not.toContain(diagnostic)
    const details = () =>
      renderer!.root.findAll(
        (node) => String(node.type) === 'Text' && String(node.props.children).includes(diagnostic)
      )
    expect(details()).toHaveLength(0)
    const disclosure = renderer!.root.find(
      (node) => String(node.type) === 'Pressable' && node.props['aria-expanded'] === false
    )
    act(() => disclosure.props.onPress())
    expect(details().length).toBeGreaterThan(0)
    act(() => renderer?.unmount())
    const hostAdvice: unknown = {
      kind: 'status',
      text: 'Custom host advice: use the enterprise model.',
      failure: agentSessionFailureFact('modelUnavailable')
    }
    if (!isAdmissibleAgentJournalItemBody(hostAdvice) || hostAdvice.kind !== 'status') {
      throw new Error('Expected host status row')
    }
    const custom = renderNotice(hostAdvice, { hostName: null, agentName: 'Codex' })
    expect(custom.props.children).toBe('Custom host advice: use the enterprise model.')
  })

  it('links a CI result line to its pull request and commit through the link sheet', () => {
    const openLink = vi.fn()
    act(() => {
      renderer = create(
        createElement(
          MarkdownLinkHandlerContext.Provider,
          { value: openLink },
          createElement(MobileNativeChatMessage, {
            message: {
              // The journal key percent-encodes the line's client message id.
              id: 'orca:pr-event%3Agithub.com%2Facme%2Frepo%233%3A8d5f74b0c1%3A1',
              role: 'system',
              blocks: [
                {
                  type: 'text',
                  text: 'CI failing on repo#3 at 8d5f74b',
                  presentation: 'pull-request-event',
                  tone: 'failure'
                }
              ],
              timestamp: 0,
              source: 'transcript'
            }
          })
        )
      )
    })
    const links = renderer!.root.findAll(
      (node) => String(node.type) === 'Text' && node.props.accessibilityRole === 'link'
    )
    // The whole lead is the PR's target, so a lead the ellipsis cuts still opens it.
    expect(links.map((link) => link.props.accessibilityLabel ?? link.props.children)).toEqual([
      'CI failing on repo#3',
      '8d5f74b'
    ])
    links.forEach((link) => act(() => link.props.onPress()))
    expect(openLink.mock.calls).toEqual([
      ['https://github.com/acme/repo/pull/3'],
      ['https://github.com/acme/repo/commit/8d5f74b0c1']
    ])
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
})
