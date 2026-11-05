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
    'keeps saved external reports in the background surface without agent status or navigation (provider %s)',
    async (provider) => {
      await activateMobileUiLocale(provider ? 'fr' : 'en')
      const from: AgentMessageSource = {
        kind: 'agent',
        orchestration: {
          message: 'mail-notice',
          mailbox: 'run:r',
          dispatchId: null,
          messages: [{ messageId: 'mail', runId: 'r', from: 'ci-notifier' }]
        },
        senders: [
          {
            name: null,
            party: { address: 'ci-notifier', terminalHandle: 'ci-notifier', orcaSessionId: null }
          }
        ]
      }
      const open = vi.fn()
      const card = (source = from) =>
        createElement(MobileNativeChatMessage, {
          message: { ...userMessage([{ type: 'text', text: 'CI completed.' }]), from: source }
        })
      const wrap = (child: ReturnType<typeof card>) =>
        provider ? (
          <MobileAgentMessageProvider
            tabs={[]}
            terminals={[]}
            scopeKey="host/workspace"
            open={open}
          >
            {child}
          </MobileAgentMessageProvider>
        ) : (
          child
        )
      try {
        act(() => {
          renderer = create(wrap(card()))
        })
        const name = findAllByHostType(renderer!.root, 'Pressable').find((node) =>
          findAllByHostType(node, 'Text').some((text) => text.children.includes('ci-notifier'))
        )
        expect(name?.props.disabled).toBe(true)
        expect(name?.props.accessibilityRole).toBeUndefined()
        expect(findAllByHostType(renderer!.root, 'Terminal')).toHaveLength(0)
        expect(findAllByHostType(renderer!.root, 'Bot')).toHaveLength(0)
        expect(findAllByHostType(renderer!.root, 'AgentStateDot')).toHaveLength(0)
        expect(findAllByHostType(renderer!.root, 'ArrowUpRight')).toHaveLength(0)
        expect(
          findAllByHostType(renderer!.root, 'Text').some((node) =>
            node.children.includes('un agent')
          )
        ).toBe(false)
        expect(open).not.toHaveBeenCalled()
        for (const savedName of [null, 'Setup']) {
          const endpoint: AgentMessageSource = {
            ...from,
            senders: [
              {
                name: savedName,
                party: { address: 'term_plain', terminalHandle: 'term_plain', orcaSessionId: null }
              }
            ]
          }
          if (endpoint.orchestration?.message === 'mail-notice') {
            endpoint.orchestration = {
              ...endpoint.orchestration,
              messages: [{ messageId: 'mail', runId: 'r', from: 'term_plain' }]
            }
          }
          act(() => renderer!.update(wrap(card(endpoint))))
          const label = savedName ?? 'Terminal'
          const action = findAllByHostType(renderer!.root, 'Pressable').find((node) =>
            findAllByHostType(node, 'Text').some((text) => text.children.includes(label))
          )
          expect(action?.props.disabled).toBe(!provider)
          expect(action?.props.accessibilityRole).toBe(provider ? 'button' : undefined)
          if (provider) {
            act(() => action!.props.onPress())
            expect(open).toHaveBeenLastCalledWith(endpoint, endpoint.senders[0])
          }
          expect(findAllByHostType(renderer!.root, 'AgentStateDot')).toHaveLength(0)
        }
      } finally {
        act(() => renderer?.unmount())
        renderer = null
        await activateMobileUiLocale('en')
      }
    }
  )
})
