import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status/contracts/agent-status-types'
import { useMobileNativeChatTerminalTurn } from './use-mobile-native-chat-terminal-turn'

const status: AgentStatusEntry = {
  state: 'working',
  prompt: '',
  updatedAt: 1,
  stateStartedAt: 10,
  paneKey: 'tab:leaf',
  stateHistory: []
}

describe('mobile Hermes terminal turn Stop suppression', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
  })

  it('releases Stop when a later Hermes working sequence arrives without an idle poll', () => {
    let api: ReturnType<typeof useMobileNativeChatTerminalTurn> | undefined
    let sequence = 1
    function Harness() {
      api = useMobileNativeChatTerminalTurn({
        status,
        terminalActivity: { state: 'working', workingSequence: sequence },
        resolution: { agent: 'hermes', sessionId: 'sess' },
        session: {
          messages: [
            {
              id: 'u',
              role: 'user',
              blocks: [{ type: 'text', text: 'go' }],
              timestamp: 1,
              source: 'transcript'
            }
          ]
        },
        latestPendingId: null,
        hasPromptCard: false,
        scopeKey: 'scope',
        stop: vi.fn(async () => true)
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    expect(api?.isWorking).toBe(true)
    act(() => {
      api?.stop()
    })
    expect(api?.isWorking).toBe(false)
    sequence = 2
    act(() => {
      renderer?.update(createElement(Harness))
    })
    expect(api?.isWorking).toBe(true)
  })
})
