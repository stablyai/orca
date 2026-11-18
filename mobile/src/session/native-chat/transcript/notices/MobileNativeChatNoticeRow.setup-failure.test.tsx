import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatTextBlock } from '../../../../../../src/shared/native-chat/native-chat-types'
import { agentSessionFailureFact } from '../../../../../../src/shared/agent-session/failures/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement(name, props, children)
  return {
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
    Image: host('Image'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock(
  'lucide-react-native',
  () =>
    new Proxy(
      {},
      { get: (_icons, name) => (name === 'then' ? undefined : String(name)), has: () => true }
    )
)
vi.mock('../bot-cards/mobile-native-chat-bot-cards', () => ({
  mobileNativeChatBotCard: () => null
}))
vi.mock('../message-content/MobileNativeChatMarkdown', () => ({
  MobileNativeChatMarkdown: 'MobileNativeChatMarkdown'
}))

import { MobileNativeChatNoticeRow } from './MobileNativeChatNoticeRow'
import { MobileNativeChatNoticeContext } from './mobile-native-chat-notice-context'
import { colors } from '../../../../theme/mobile-theme'

const SIGN_IN_FAILURE: NativeChatTextBlock = {
  type: 'text',
  tone: 'error',
  text: 'Sign in to Pi.',
  failure: agentSessionFailureFact('notSignedIn')
}

const NOT_INSTALLED_FAILURE: NativeChatTextBlock = {
  type: 'text',
  tone: 'error',
  text: 'Pi is not installed.',
  failure: agentSessionFailureFact('cliMissing')
}

const SUCCEEDED_TURN: AgentJournalRenderItem = {
  itemId: 'turn-5',
  sequence: 5,
  revision: 2,
  observedAt: 5,
  body: { kind: 'turn', turnId: 't-5', state: 'completed', outcome: 'success' }
}

function textOf(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('')
}

describe('mobile setup failure row', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function renderFailure(block: NativeChatTextBlock, sequence: number): ReactTestInstance {
    act(() => {
      renderer?.unmount()
      renderer = create(
        createElement(
          MobileNativeChatNoticeContext.Provider,
          {
            value: {
              hostName: null,
              agentName: 'Pi',
              onRunInTerminal: () => {},
              latestSucceededTurn: SUCCEEDED_TURN
            }
          },
          createElement(MobileNativeChatNoticeRow, {
            blocks: [block],
            fontScale: 1,
            message: { id: 'failure', journalPosition: { sequence, index: 0 } }
          })
        )
      )
    })
    return renderer!.root
  }
  const signInButtons = (root: ReactTestInstance) =>
    root.findAll((node) => String(node.type) === 'Pressable' && textOf(node) === 'Sign in')
  const failureColor = (root: ReactTestInstance, text: string) =>
    root
      .find((node) => String(node.type) === 'Text' && textOf(node) === text)
      .props.style.findLast(
        (style: unknown) => typeof style === 'object' && style !== null && 'color' in style
      )?.color

  it('mutes a failure a later turn succeeded past and drops its Sign in', () => {
    const resolved = renderFailure(SIGN_IN_FAILURE, 2)
    expect(signInButtons(resolved)).toHaveLength(0)
    expect(failureColor(resolved, SIGN_IN_FAILURE.text)).toBe(colors.textMuted)
    const current = renderFailure(SIGN_IN_FAILURE, 7)
    expect(signInButtons(current)).toHaveLength(1)
    expect(failureColor(current, SIGN_IN_FAILURE.text)).toBe(colors.statusRed)
  })

  it('mutes a not-installed failure a later turn succeeded past, as desktop does', () => {
    const resolved = renderFailure(NOT_INSTALLED_FAILURE, 2)
    expect(failureColor(resolved, NOT_INSTALLED_FAILURE.text)).toBe(colors.textMuted)
    const current = renderFailure(NOT_INSTALLED_FAILURE, 7)
    expect(failureColor(current, NOT_INSTALLED_FAILURE.text)).toBe(colors.statusRed)
  })
})
