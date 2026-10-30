import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-freshness'
import type { RuntimeWorktreeAgentRow } from '../../shared/runtime-types'
import type { RuntimeTerminalTitleEvidence } from './runtime-worktree-ps-activity'
import { resolveRuntimeWorktreeSidebarStatus } from './runtime-worktree-sidebar-status'

const NOW = 10_000_000
const AGENT_PANE = 'tab-1:1'
const OTHER_PANE = 'tab-2:1'

function doneRow(outcome: 'failure' | 'success', updatedAt = NOW): RuntimeWorktreeAgentRow {
  return {
    paneKey: AGENT_PANE,
    parentPaneKey: null,
    state: 'done',
    agentType: 'claude',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    mainAgent: { state: 'done', outcome, stateStartedAt: updatedAt },
    stateStartedAt: updatedAt,
    updatedAt
  }
}

function title(
  status: RuntimeTerminalTitleEvidence['status'],
  paneKey: string
): RuntimeTerminalTitleEvidence {
  return { status, paneKey, ptyId: null, tabId: null }
}

function resolve(
  status: 'active' | 'working' | 'permission',
  agents: RuntimeWorktreeAgentRow[],
  titles: RuntimeTerminalTitleEvidence[] = []
) {
  return resolveRuntimeWorktreeSidebarStatus({ status, agents }, NOW, titles, (paneKey) =>
    paneKey === AGENT_PANE ? { paneKey, ptyId: undefined, tabId: 'tab-1' } : undefined
  )
}

describe('resolveRuntimeWorktreeSidebarStatus', () => {
  it('keeps another pane’s question above a failed turn, but not the failed pane’s own title', () => {
    expect(resolve('permission', [doneRow('failure')], [title('permission', OTHER_PANE)])).toBe(
      'permission'
    )
    expect(resolve('permission', [doneRow('failure')], [title('permission', AGENT_PANE)])).toBe(
      'failed'
    )
  })

  it('lets a finished turn show through its own pane’s lingering working title', () => {
    expect(resolve('working', [doneRow('success')], [title('working', AGENT_PANE)])).toBe('done')
    expect(resolve('working', [doneRow('success')], [title('working', OTHER_PANE)])).toBe('working')
  })

  it('falls back to the host status once the agent row is stale', () => {
    expect(resolve('active', [doneRow('failure', NOW - AGENT_STATUS_STALE_AFTER_MS - 1)])).toBe(
      'active'
    )
  })
})
