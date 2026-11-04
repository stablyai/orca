import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import './mobile-agent-message-renderer.test-fixture'
import { activateMobileUiLocale } from '../../../i18n/mobile-i18n'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileAgentMessageProvider } from './MobileAgentMessageProvider'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { findAllByHostType } from '../../../test-support/react-test-renderer-host-nodes'
const userMessage = (blocks: NativeChatMessage['blocks']): NativeChatMessage => ({
  id: 'u1',
  role: 'user',
  blocks,
  timestamp: null,
  source: 'transcript'
})
describe('phone sender provider', () => {
  let renderer: ReactTestRenderer | null = null
  it.each([false, true])(
    'keeps command source names and glyphs without navigation (provider %s)',
    async (provider) => {
      await activateMobileUiLocale(provider ? 'fr' : 'en')
      const from: AgentMessageSource = {
        kind: 'agent',
        orchestration: null,
        senders: [
          {
            name: null,
            party: { address: 'ci-notifier', terminalHandle: 'ci-notifier', orcaSessionId: null }
          }
        ]
      }
      const open = vi.fn()
      const card = createElement(MobileNativeChatMessage, {
        message: { ...userMessage([{ type: 'text', text: 'CI completed.' }]), from }
      })
      try {
        act(() => {
          renderer = create(
            provider ? (
              <MobileAgentMessageProvider
                tabs={[]}
                terminals={[]}
                scopeKey="host/workspace"
                open={open}
              >
                {card}
              </MobileAgentMessageProvider>
            ) : (
              card
            )
          )
        })
        const name = findAllByHostType(renderer!.root, 'Pressable').find((node) =>
          findAllByHostType(node, 'Text').some((text) => text.children.includes('ci-notifier'))
        )
        expect(name?.props.disabled).toBe(true)
        expect(name?.props.accessibilityRole).toBeUndefined()
        expect(findAllByHostType(renderer!.root, 'Terminal')).toHaveLength(1)
        expect(findAllByHostType(renderer!.root, 'Bot')).toHaveLength(0)
        expect(findAllByHostType(renderer!.root, 'AgentStateDot')).toHaveLength(0)
        expect(findAllByHostType(renderer!.root, 'ArrowUpRight')).toHaveLength(0)
        expect(
          findAllByHostType(renderer!.root, 'Text').some((node) =>
            node.children.includes('un agent')
          )
        ).toBe(false)
        expect(open).not.toHaveBeenCalled()
      } finally {
        act(() => renderer?.unmount())
        renderer = null
        await activateMobileUiLocale('en')
      }
    }
  )
})
