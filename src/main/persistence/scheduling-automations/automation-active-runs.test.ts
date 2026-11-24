import { describe, expect, it } from 'vitest'
import type {
  AutomationRun,
  AutomationRunStatus
} from '../../../shared/automations/history/automation-run'
import { listActiveAutomationRunsInto } from './automation-active-runs'

function run(id: string, status: AutomationRunStatus, chatSessionId = 'chat-1'): AutomationRun {
  return {
    id,
    automationId: 'automation-1',
    title: id,
    scheduledFor: 20,
    status,
    trigger: 'manual',
    workspaceId: 'wt',
    workspaceDisplayName: 'wt',
    sessionKind: 'chat',
    chatSessionId,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 20,
    dispatchedAt: 20,
    createdAt: 20,
    runNumber: 1
  }
}

describe('runs not yet final', () => {
  it('reads only the named chats, from one walk per run history', () => {
    const state = {
      automationRuns: [
        run('done', 'completed'),
        run('going', 'dispatched'),
        run('elsewhere', 'dispatched', 'chat-2')
      ]
    }
    expect(listActiveAutomationRunsInto(state, ['chat-1']).map(({ id }) => id)).toEqual(['going'])
    expect(listActiveAutomationRunsInto(state, ['chat-3'])).toEqual([])

    // A mutation replaces the array, so the next read sees it.
    state.automationRuns = state.automationRuns.map((entry) =>
      entry.id === 'going' ? { ...entry, status: 'completed' as const } : entry
    )
    expect(listActiveAutomationRunsInto(state, ['chat-1'])).toEqual([])
    expect(listActiveAutomationRunsInto(state, ['chat-2']).map(({ id }) => id)).toEqual([
      'elsewhere'
    ])
  })
})
