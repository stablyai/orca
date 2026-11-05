import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalThreadGoal } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { WorkspaceServerContext } from '../transport/workspace-server-context'
import {
  useMobileStructuredThreadGoal,
  type MobileStructuredThreadGoal
} from './use-mobile-structured-thread-goal'

const GOAL: AgentJournalThreadGoal = {
  objective: 'Ship the parser',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1_000,
  updatedAt: 1_000
}

type Route = {
  report: 'host' | 'agent'
  phoneThreadGoal: boolean
  /** Undefined: the phone reaches the host directly, not through a paired desktop. */
  desktopRelays?: boolean
}

function mount(route: Route) {
  const mutate = vi.fn(async () => ({ status: 'accepted' as const, value: {}, sameFence: true }))
  const send = vi.fn(async () => 'accepted' as const)
  let goal: MobileStructuredThreadGoal | null = null
  function Probe(): null {
    const result = useMobileStructuredThreadGoal(
      {
        hostSupport: { phoneThreadGoal: route.phoneThreadGoal } as never,
        enabled: true,
        connected: true,
        onSendError: () => {}
      },
      { items: [], epoch: null, hostClock: null },
      {
        sessionKey: 'chat-1',
        report:
          route.report === 'host'
            ? { support: { current: GOAL }, reported: undefined }
            : { support: undefined, reported: { current: GOAL } },
        turnId: null,
        workingStartedAt: null,
        working: false,
        mutate: mutate as never,
        commands: {}
      }
    )
    result.sendRef.current = send
    goal = result.threadGoal
    return null
  }
  const tree = (children: ReactNode) =>
    route.desktopRelays === undefined
      ? children
      : createElement(
          WorkspaceServerContext.Provider,
          {
            value: {
              client: null,
              state: 'connected',
              desktopCapabilities: route.desktopRelays ? ['agent-session.thread-goal.phone.v1'] : []
            }
          },
          children
        )
  act(() => {
    create(tree(createElement(Probe)) as never)
  })
  return { goal: () => goal!, mutate, send }
}

describe('useMobileStructuredThreadGoal', () => {
  it.each([
    { route: { report: 'host', phoneThreadGoal: true }, changes: 'host' },
    { route: { report: 'host', phoneThreadGoal: true, desktopRelays: true }, changes: 'host' },
    // An older paired desktop refuses to forward the method to a newer server.
    { route: { report: 'host', phoneThreadGoal: true, desktopRelays: false }, changes: null },
    // An older host reports the goal but refuses the phone's goal changes.
    { route: { report: 'host', phoneThreadGoal: false }, changes: null },
    { route: { report: 'agent', phoneThreadGoal: false }, changes: 'agent' }
  ] as const)('offers $changes changes for $route', ({ route, changes }) => {
    expect(mount(route).goal().changes).toBe(changes)
  })

  it('pauses a host goal through the host goal method', async () => {
    const { goal, mutate, send } = mount({ report: 'host', phoneThreadGoal: true })
    await act(async () => {
      expect(await goal().change({ kind: 'status', status: 'paused' })).toBe(true)
    })
    expect(mutate).toHaveBeenCalledWith('agentSession.threadGoal', 'agentSession.threadGoal', {
      change: { kind: 'status', status: 'paused' }
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('clears an agent-owned goal with its own command and cannot pause it', async () => {
    const { goal, mutate, send } = mount({ report: 'agent', phoneThreadGoal: true })
    await act(async () => {
      expect(await goal().change({ kind: 'status', status: 'paused' })).toBe(false)
      expect(await goal().change({ kind: 'clear' })).toBe(true)
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('/goal clear')
    expect(mutate).not.toHaveBeenCalled()
  })

  it('sends nothing when the host refuses the phone goal changes', async () => {
    const { goal, mutate, send } = mount({ report: 'host', phoneThreadGoal: false })
    await act(async () => {
      expect(await goal().change({ kind: 'clear' })).toBe(false)
    })
    expect(mutate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
