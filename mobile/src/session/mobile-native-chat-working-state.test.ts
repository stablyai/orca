import { describe, expect, it } from 'vitest'
import type { NativeChatTurnLifecycle } from '../../../src/shared/native-chat-types'
import type { MobileWebNativeChatAgentStatus } from '../../../src/shared/mobile-web/native-chat-operation-contract'
import { isMobileNativeChatAgentWorking } from './mobile-native-chat-working-state'

const workingStatus: MobileWebNativeChatAgentStatus = {
  state: 'working',
  stateStartedAt: 200
}

function lifecycle(
  state: NativeChatTurnLifecycle['state'],
  timestamp: number | null
): NativeChatTurnLifecycle {
  return { state, turnId: `${state}-turn`, timestamp }
}

describe('isMobileNativeChatAgentWorking', () => {
  it('uses the working hook state until terminal transcript evidence catches up', () => {
    expect(isMobileNativeChatAgentWorking(workingStatus, undefined)).toBe(true)
    expect(isMobileNativeChatAgentWorking(workingStatus, lifecycle('working', 210))).toBe(true)
    expect(isMobileNativeChatAgentWorking(workingStatus, lifecycle('completed', 199))).toBe(true)
  })

  it.each(['completed', 'interrupted'] as const)(
    'suppresses a stale working hook after a newer %s lifecycle',
    (state) => {
      expect(isMobileNativeChatAgentWorking(workingStatus, lifecycle(state, 200))).toBe(false)
      expect(isMobileNativeChatAgentWorking(workingStatus, lifecycle(state, 201))).toBe(false)
    }
  )

  it('does not let undated or incomparable lifecycle evidence suppress a working turn', () => {
    expect(isMobileNativeChatAgentWorking(workingStatus, lifecycle('interrupted', null))).toBe(true)
    expect(isMobileNativeChatAgentWorking({ state: 'working' }, lifecycle('completed', 201))).toBe(
      true
    )
  })

  it('never reports a non-working hook state as working', () => {
    expect(
      isMobileNativeChatAgentWorking(
        { state: 'done', stateStartedAt: 200 },
        lifecycle('working', 201)
      )
    ).toBe(false)
  })

  // Why: a monitoring agent is working without holding the foreground; treating it as busy
  // shows the spinner, the Stop button and a live streaming bubble for work it is not doing.
  it('never reports a monitoring agent as working', () => {
    const monitoring = { ...workingStatus, workingMode: 'monitoring' as const }

    expect(isMobileNativeChatAgentWorking(monitoring, undefined)).toBe(false)
    expect(isMobileNativeChatAgentWorking(monitoring, lifecycle('working', 210))).toBe(false)
  })
})
