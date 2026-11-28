import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import {
  createRuntimeAutomationRunTerminalObserver,
  type AutomationRunTerminalHost
} from './runtime-terminal-run-observer'

const STARTED_AT = 1_000

function dispatchedRun(): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    title: 'Nightly',
    scheduledFor: STARTED_AT,
    status: 'dispatched',
    trigger: 'scheduled',
    workspaceId: 'ws-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    terminalPaneKey: 'tab-1:1',
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: STARTED_AT,
    dispatchedAt: STARTED_AT,
    createdAt: STARTED_AT
  }
}

/** A pane that never reads idle because it is held by the blocked screen a wait reports. */
function heldPane(blockedReason: string): AutomationRunTerminalHost {
  return {
    getTerminalHandleForPaneKey: () => 'term-1',
    canOpenRunTerminals: () => true,
    readTerminal: async () => ({ tail: ['Sign in to continue'] }),
    waitForTerminal: async () => ({ satisfied: false, blockedReason })
  }
}

function observeBlocked(blockedReason: string) {
  return createRuntimeAutomationRunTerminalObserver(heldPane(blockedReason)).observeCompletion(
    'term-1',
    { signal: new AbortController().signal, run: dispatchedRun() }
  )
}

describe('a scheduled run whose agent stops at a sign-in screen', () => {
  it('ends as a skip the history can act on, not as a dispatch failure', async () => {
    const observation = await observeBlocked('agent-sign-in-prompt')
    expect(observation.status).toBe('skipped_needs_interactive_auth')
    expect(observation.error).toBe('Automation agent is blocked: agent-sign-in-prompt.')
  })

  it('keeps every other blocked screen a dispatch failure', async () => {
    const observation = await observeBlocked('agent-approval-prompt')
    expect(observation.status).toBe('dispatch_failed')
  })
})
