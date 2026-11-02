import { createElement } from 'react'
import { parseOrcaSessionAddress } from '../../../../../src/shared/orca-session-address'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { proseRenderCount } from './mobile-agent-message-renderer.test-fixture'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import * as senderSelection from './mobile-agent-message-context'
import { MobileAgentMessageProvider } from './MobileAgentMessageProvider'
import type { MobileSessionTab } from '../../mobile-session-route-types'
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
  it.each([10, 100])(
    'indexes production inputs once at %i rows and isolates settled selected consumers',
    (count) => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)
      const names = new Map<string, number>(),
        avatars = new Map<string, number>()
      const readName = senderSelection.useMobileAgentMessageName
      const readView = senderSelection.useMobileAgentMessageView
      const nameSpy = vi
        .spyOn(senderSelection, 'useMobileAgentMessageName')
        .mockImplementation((sender, fallback) => {
          names.set(sender.party.address, (names.get(sender.party.address) ?? 0) + 1)
          return readName(sender, fallback)
        })
      const viewSpy = vi
        .spyOn(senderSelection, 'useMobileAgentMessageView')
        .mockImplementation((sender) => {
          const key = sender?.party.address ?? ''
          avatars.set(key, (avatars.get(key) ?? 0) + 1)
          return readView(sender)
        })
      let tabReads = 0,
        identityReads = 0
      const tabs: MobileSessionTab[] = Array.from({ length: count }, (_, index) => ({
        type: 'terminal',
        id: `tab${index}`,
        title: `Tab ${index}`,
        isActive: false,
        get terminal() {
          tabReads++
          return `term_${index}`
        },
        agentStatus: {
          paneKey: `tab${index}:11111111-1111-4111-8111-111111111111`,
          state: 'done',
          agentType: 'claude',
          prompt: '',
          updatedAt: 1_000_000,
          stateStartedAt: 1_000_000,
          stateHistory: []
        }
      }))
      const terminals = Array.from({ length: count }, (_, index) => ({
        handle: `term_${index}`,
        get agentIdentity() {
          identityReads++
          return 'claude'
        }
      }))
      const open = vi.fn()
      const cards = tabs.map((_, index) => {
        const from: AgentMessageSource = {
          kind: 'agent',
          orchestration: null,
          senders: [
            {
              name: 'Snapshot name',
              party: {
                address: `term_${index}`,
                terminalHandle: `term_${index}`,
                orcaSessionId: null
              }
            }
          ]
        }
        return createElement(MobileNativeChatMessage, {
          key: index,
          message: { ...userMessage([{ type: 'text', text: 'body' }]), id: `m${index}`, from }
        })
      })
      const named: AgentMessageSource = {
        kind: 'agent',
        orchestration: null,
        senders: [
          {
            name: 'Snapshot chat',
            party: {
              address: 'orca:visible',
              orcaSessionId: parseOrcaSessionAddress('orca_session_id:visible-chat'),
              terminalHandle: null
            }
          }
        ]
      }
      cards.push(
        createElement(MobileNativeChatMessage, {
          key: 'visible',
          message: { ...userMessage([{ type: 'text', text: 'body' }]), id: 'visible', from: named }
        })
      )
      const draw = (rows = tabs, records = terminals) => (
        <MobileAgentMessageProvider
          tabs={rows}
          terminals={records}
          scopeKey="host/workspace"
          open={open}
        >
          {cards}
        </MobileAgentMessageProvider>
      )
      try {
        act(() => {
          renderer = create(draw())
        })
        expect(tabReads).toBe(3 * count)
        expect(identityReads).toBe(count)
        const bodyRenders = proseRenderCount()
        names.clear()
        avatars.clear()
        tabReads = 0
        identityReads = 0
        act(() => {
          renderer!.update(
            draw([
              ...tabs,
              {
                type: 'agent-session',
                id: 'other',
                sessionId: 'other',
                title: 'Other',
                agent: 'codex',
                isActive: false
              }
            ])
          )
        })
        expect(tabReads).toBe(3 * count)
        expect(identityReads).toBe(0)
        expect([...names.values(), ...avatars.values()]).toEqual([])
        act(() => {
          renderer!.update(draw())
        })
        names.clear()
        avatars.clear()
        tabReads = 0
        act(() => {
          vi.advanceTimersByTime(60_000)
        })
        expect(tabReads).toBe(0)
        expect([...names.values(), ...avatars.values()]).toEqual([])
        // A parent publication for another host has identical scoped inputs.
        act(() => {
          renderer!.update(draw())
        })
        expect(tabReads).toBe(0)
        act(() => {
          renderer!.update(
            draw(tabs.map((tab, index) => (index === 0 ? { ...tab, title: 'Masked rename' } : tab)))
          )
        })
        expect([...names.values(), ...avatars.values()]).toEqual([])
        act(() => {
          renderer!.update(
            draw(
              tabs,
              terminals.map((record, index) =>
                index === 0 ? { ...record, agentIdentity: 'cursor' } : record
              )
            )
          )
        })
        expect([...avatars.keys()]).toEqual(['term_0'])
        expect(names.size).toBe(0)
        expect(renderer!.root.findAllByType(MobileAgentMessageProvider)).toHaveLength(1)
        names.clear()
        avatars.clear()
        const namedTab: MobileSessionTab = {
          type: 'agent-session',
          id: 'visible-tab',
          sessionId: 'visible-chat',
          title: 'Current chat',
          agent: 'codex',
          isActive: false
        }
        act(() => {
          renderer!.update(draw([...tabs, namedTab]))
        })
        expect([...names.keys()]).toEqual(['orca:visible'])
        names.clear()
        avatars.clear()
        act(() => {
          renderer!.update(draw([...tabs, { ...namedTab, title: 'Renamed chat' }]))
        })
        expect([...names.keys()]).toEqual(['orca:visible'])
        expect(
          findAllByHostType(renderer!.root, 'Text').some(
            (node) => node.props.children === 'Renamed chat'
          )
        ).toBe(true)
        expect(avatars.size).toBe(0)
        names.clear()
        avatars.clear()
        const working: MobileSessionTab[] = tabs.map((tab, index) =>
          index === 0 && tab.type === 'terminal' && tab.agentStatus
            ? {
                ...tab,
                agentStatus: { ...tab.agentStatus, state: 'working', updatedAt: Date.now() }
              }
            : tab
        )
        act(() => {
          renderer!.update(draw(working))
        })
        names.clear()
        avatars.clear()
        tabReads = 0
        vi.setSystemTime(Date.now() + 31 * 60_000)
        act(() => {
          vi.advanceTimersByTime(60_000)
        })
        expect([...avatars.keys()]).toEqual(['term_0'])
        expect(names.size).toBe(0)
        expect(tabReads).toBe(0)
        names.clear()
        avatars.clear()
        act(() => {
          renderer!.update(draw(working.slice(1)))
        })
        expect([...avatars.keys()]).toEqual(['term_0'])
        avatars.clear()
        act(() => {
          renderer!.update(draw(working))
        })
        expect([...avatars.keys()]).toEqual(['term_0'])
        expect(proseRenderCount()).toBe(bodyRenders)
        const arrow = findAllByHostType(renderer!.root, 'Pressable').find(
          (node) => node.props.accessibilityRole === 'button' && !node.props.accessibilityState
        )!
        act(() => arrow.props.onPress())
        expect(open).toHaveBeenCalledOnce()
      } finally {
        act(() => renderer?.unmount())
        renderer = null
        nameSpy.mockRestore()
        viewSpy.mockRestore()
        vi.useRealTimers()
      }
    }
  )
})
