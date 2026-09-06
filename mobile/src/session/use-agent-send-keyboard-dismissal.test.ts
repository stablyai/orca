import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentSendKeyboardDismissal } from './use-agent-send-keyboard-dismissal'

const hardware = vi.hoisted(() => ({ connected: false }))
vi.mock('@orca/expo-hardware-keyboard-navigation', () => ({
  isHardwareKeyboardConnected: () => hardware.connected
}))

describe('accepted agent send keyboard focus', () => {
  afterEach(() => {
    hardware.connected = false
  })

  it('checks current keyboard attachment when a delayed send settles', () => {
    const dismiss = vi.fn()
    let finish: ReturnType<typeof useAgentSendKeyboardDismissal> | undefined
    function Harness() {
      finish = useAgentSendKeyboardDismissal(dismiss, () => 1)
      return null
    }
    let renderer: ReturnType<typeof create>
    act(() => {
      renderer = create(createElement(Harness))
    })
    const origin = {
      generation: 1,
      tab: { type: 'terminal', title: 'Claude', agentStatus: { agentType: 'claude' as const } }
    }
    hardware.connected = true
    finish!(origin, true)
    expect(dismiss).not.toHaveBeenCalled()
    hardware.connected = false
    finish!(origin, true)
    expect(dismiss).toHaveBeenCalledOnce()
    act(() => renderer!.unmount())
  })
})
