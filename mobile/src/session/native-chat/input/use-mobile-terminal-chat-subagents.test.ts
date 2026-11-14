import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../src/shared/agent-status/contracts/agent-status-types'
import { useMobileTerminalChatSubagents } from './use-mobile-terminal-chat-subagents'

const NOW = 10_000_000

vi.mock('../../../hooks/use-now', () => ({
  useSharedNowSnapshot: <T>(_intervalMs: number, read: (now: number) => T): T => read(Date.now())
}))

afterEach(() => {
  vi.useRealTimers()
})

it("lists a terminal chat's running subagents and stops vouching for them off the socket", () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  const status: AgentStatusEntry = {
    state: 'working',
    prompt: 'audit the repo',
    updatedAt: NOW - 1_000,
    stateStartedAt: NOW - 60_000,
    paneKey: 'tab-a:leaf-a',
    stateHistory: [],
    subagents: [
      { id: '9c6e44530fd9', agentType: 'Explore', state: 'working', startedAt: NOW - 42_000 }
    ]
  }
  let strip: ReturnType<typeof useMobileTerminalChatSubagents> | undefined
  function Probe({ connected }: { connected: boolean }): null {
    strip = useMobileTerminalChatSubagents({
      sessionKey: 'host\0worktree\0tab-a',
      status,
      connected,
      turnActive: true
    })
    return null
  }
  const shown = (): unknown => ({
    show: strip?.view.show,
    rows: strip?.rows.map((row) => ({
      name: row.name,
      idSuffix: row.idSuffix,
      displayState: row.displayState,
      firstObservedAt: row.firstObservedAt
    }))
  })

  let renderer: TestRenderer.ReactTestRenderer | undefined
  act(() => {
    renderer = TestRenderer.create(createElement(Probe, { connected: true }))
  })
  expect(shown()).toEqual({
    show: true,
    rows: [
      {
        name: 'Explore',
        displayState: 'working',
        firstObservedAt: NOW - 42_000
      }
    ]
  })

  act(() => renderer?.update(createElement(Probe, { connected: false })))
  expect(shown()).toEqual({
    show: true,
    rows: [
      {
        name: 'Explore',
        displayState: 'unverifiable',
        firstObservedAt: NOW - 42_000
      }
    ]
  })
  act(() => renderer?.unmount())
})
