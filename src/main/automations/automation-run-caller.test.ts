import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../shared/automations-types'
import { AUTOMATION_RUN_REPORT_GRACE_MS } from '../../shared/automation-run-results'
import {
  AutomationRunCallerError,
  resolveCallerAutomationRun,
  terminalCallerSession
} from './automation-run-caller'

function terminalRun(id: string, overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id,
    automationId: 'a1',
    title: 'Run',
    scheduledFor: 0,
    status: 'dispatched',
    trigger: 'manual',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: 'tab-1:leaf-1',
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    createdAt: 1,
    dispatchedAt: 1,
    ...overrides
  }
}

const session = { kind: 'terminal', paneKey: 'tab-1:leaf-1', ptyId: 'pty-1' } as const

describe('resolveCallerAutomationRun', () => {
  it('sends a reused session to the newest run it is serving', () => {
    const runs = [
      terminalRun('older', { status: 'completed', finishedAt: 5, dispatchedAt: 1 }),
      terminalRun('current', { dispatchedAt: 10 })
    ]

    expect(resolveCallerAutomationRun(runs, session, 11).id).toBe('current')
  })

  it('accepts a finished run only inside the grace window', () => {
    const runs = [terminalRun('done', { status: 'completed', finishedAt: 100 })]

    expect(resolveCallerAutomationRun(runs, session, 100 + AUTOMATION_RUN_REPORT_GRACE_MS).id).toBe(
      'done'
    )
    expect(() =>
      resolveCallerAutomationRun(runs, session, 101 + AUTOMATION_RUN_REPORT_GRACE_MS)
    ).toThrow(AutomationRunCallerError)
  })

  it('refuses a pane whose PTY was replaced since the run launched', () => {
    expect(() =>
      resolveCallerAutomationRun([terminalRun('r1')], { ...session, ptyId: 'pty-2' }, 2)
    ).toThrow(AutomationRunCallerError)
  })

  it('matches chat runs by session id', () => {
    const runs = [
      terminalRun('chat', { sessionKind: 'chat', chatSessionId: 's1', terminalPaneKey: null })
    ]

    expect(resolveCallerAutomationRun(runs, { kind: 'chat', sessionIds: ['s1'] }, 2).id).toBe(
      'chat'
    )
  })
})

describe('terminalCallerSession', () => {
  const runtime = {
    getTerminalHandleForPaneKey: (paneKey: string) => (paneKey === 'tab-1:leaf-1' ? 'h1' : null),
    getTerminalPtyIdForHandle: (handle: string) => (handle === 'h1' ? 'pty-1' : null)
  }

  it('requires the claimed handle to own the claimed pane on this host', () => {
    expect(
      terminalCallerSession(runtime, { terminalHandle: 'h1', paneKey: 'tab-1:leaf-1' })
    ).toEqual(session)
    expect(terminalCallerSession(runtime, { terminalHandle: 'h2', paneKey: 'tab-1:leaf-1' })).toBe(
      null
    )
    expect(
      terminalCallerSession(runtime, {
        terminalHandle: 'h1',
        paneKey: 'tab-1:leaf-1',
        host: { kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }
      })
    ).toBe(null)
  })
})
