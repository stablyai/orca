import { describe, expect, it } from 'vitest'
import { deepStrictEqual } from 'node:assert/strict'
import {
  createSessionTabsTabDeltaDecoder,
  createSessionTabsTabDeltaEncoder
} from '../../../src/shared/session-tabs-tab-delta'
import { SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY } from '../../../src/shared/session-tabs-runtime-capabilities'
import { shouldClearNativeChatWorkingSuppression } from '../../../src/shared/native-chat/native-chat-working-suppression'
import { isRpcResponse } from '../transport/rpc-response-shape'
import { resolveMobileTerminalTabAgentId } from './mobile-terminal-tab-agent'
import {
  canShowMobileNativeChat,
  resolveMobileNativeChat,
  withRememberedNativeChatIdentity
} from './native-chat/mobile-native-chat-eligibility'
import { shouldDismissKeyboardAfterTerminalSend } from './agent-send-keyboard-dismissal'
import { agentDotState } from '../worktree/agent-row-display'
import type { MobileSessionTab } from './mobile-session-route-types'
import {
  withSessionTabStatusReceipts,
  withoutSessionTabHostOwnership
} from './mobile-session-tab-status-clock'

const MINUTE = 60 * 1000
const PHONE_NOW = 1_800_000_000_000

const terminal = (hostStamp: number): MobileSessionTab => ({
  type: 'terminal',
  id: 'term::leaf',
  title: 'claude',
  terminal: 'pty-1',
  isActive: true,
  agentStatus: {
    state: 'working',
    prompt: '',
    paneKey: 'term:leaf',
    stateHistory: [],
    stateStartedAt: hostStamp,
    updatedAt: hostStamp,
    evidenceObservedAt: hostStamp
  }
})

const chat = (structuredHostOwned: boolean): MobileSessionTab => ({
  type: 'agent-session',
  id: 'agent-session:s1',
  title: 'Claude',
  sessionId: 's1',
  agent: 'claude',
  isActive: false,
  chatStatus: {
    state: 'working',
    updatedAt: PHONE_NOW - 2 * 60 * MINUTE,
    ...(structuredHostOwned ? { structuredHostOwned: true as const } : {})
  }
})

function dot(tab: MobileSessionTab | undefined, now: number) {
  if (tab?.type === 'terminal' && tab.agentStatus) {
    return agentDotState(tab.agentStatus, now)
  }
  return tab?.type === 'agent-session' && tab.chatStatus ? agentDotState(tab.chatStatus, now) : null
}

describe('session tab status on the phone clock', () => {
  it('preserves phone display and action inputs with optional origins through the wire codec', () => {
    const base = terminal(PHONE_NOW - MINUTE)
    if (base.type !== 'terminal' || !base.agentStatus) {
      throw new Error('Expected terminal status')
    }
    const status = {
      ...base.agentStatus,
      agentType: 'claude',
      providerSession: { key: 'session_id' as const, id: 'session-1' }
    }
    const results = [[], [SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY]].flatMap((capabilities) => {
      const encoder = createSessionTabsTabDeltaEncoder(capabilities)
      const decoder = createSessionTabsTabDeltaDecoder()
      return [undefined, PHONE_NOW - 10 * MINUTE].map((origin, version) => {
        const tab = {
          ...base,
          agentStatus: {
            ...status,
            ...(origin === undefined ? {} : { firstStateStartedAt: origin })
          }
        }
        const frame = {
          type: 'snapshot',
          worktree: 'wt-1',
          snapshotVersion: version + 1,
          tabs: [tab, { ...base, id: 'quiet' }],
          activeTabId: tab.id,
          activeTabType: 'terminal' as const
        }
        const sent = version === 0 ? encoder.full(frame) : encoder.update(frame)
        expect(Object.hasOwn(sent, 'tabsDelta')).toBe(capabilities.length > 0 && version > 0)
        const response: unknown = JSON.parse(
          JSON.stringify({ id: 'stream-1', ok: true, result: sent })
        )
        if (!isRpcResponse(response) || !response.ok) {
          throw new Error('Expected accepted RPC envelope')
        }
        const decoded = decoder.decode(response.result)
        deepStrictEqual(decoded, { ok: true as const, result: frame })
        const received = withRememberedNativeChatIdentity(
          withSessionTabStatusReceipts(decoded.result.tabs, [], PHONE_NOW),
          []
        )[0]
        if (received.type !== 'terminal' || !received.agentStatus) {
          throw new Error('Expected received terminal status')
        }
        return {
          dot: dot(received, PHONE_NOW),
          agent: resolveMobileTerminalTabAgentId(received),
          chat: resolveMobileNativeChat(received),
          sendAccepted: shouldDismissKeyboardAfterTerminalSend(received, true),
          chatAllowed: canShowMobileNativeChat(received),
          stopEpoch: received.agentStatus.stateStartedAt,
          clearsStop: shouldClearNativeChatWorkingSuppression({
            working: received.agentStatus.state === 'working',
            interrupted: true,
            workingEpoch: received.agentStatus.stateStartedAt,
            previousWorkingEpoch: status.stateStartedAt
          })
        }
      })
    })
    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({
        dot: 'working',
        agent: 'claude',
        chat: {
          agent: 'claude',
          sessionId: 'session-1',
          sessionLive: true,
          transcriptPath: null,
          agentConfirmed: true
        },
        sendAccepted: true,
        chatAllowed: true,
        stopEpoch: status.stateStartedAt,
        clearsStop: false
      }))
    )
  })

  it.each([
    ['an hour behind', -60 * MINUTE],
    ['an hour ahead', 60 * MINUTE]
  ])('ages a host %s from when the phone saw the evidence', (_label, skew) => {
    const first = withSessionTabStatusReceipts([terminal(PHONE_NOW + skew)], [], PHONE_NOW)
    expect(dot(first[0], PHONE_NOW)).toBe('working')
    const replay = withSessionTabStatusReceipts(
      [terminal(PHONE_NOW + skew)],
      first,
      PHONE_NOW + 20 * MINUTE
    )
    expect(dot(replay[0], PHONE_NOW + 29 * MINUTE)).toBe('working')
    expect(dot(replay[0], PHONE_NOW + 31 * MINUTE)).toBe('idle')
  })

  it('keeps a held chat working only while the phone hears from its host', () => {
    const connected = withSessionTabStatusReceipts([chat(true)], [], PHONE_NOW)
    expect(dot(connected[0], PHONE_NOW + 60 * MINUTE)).toBe('working')

    const disconnected = withoutSessionTabHostOwnership(connected)
    expect(dot(disconnected[0], PHONE_NOW + 29 * MINUTE)).toBe('working')
    expect(dot(disconnected[0], PHONE_NOW + 31 * MINUTE)).toBe('idle')

    const reconnected = withSessionTabStatusReceipts(
      [chat(true)],
      disconnected,
      PHONE_NOW + 31 * MINUTE
    )
    expect(dot(reconnected[0], PHONE_NOW + 90 * MINUTE)).toBe('working')
  })
})
