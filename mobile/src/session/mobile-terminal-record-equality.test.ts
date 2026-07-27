import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import type { MobileTerminalTheme } from '../terminal/terminal-webview-contract'
import { agentStatusEntriesEqual, terminalThemesEqual } from './mobile-terminal-record-equality'

function createAgentStatus(): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'ship it',
    updatedAt: 20,
    stateStartedAt: 10,
    agentType: 'claude',
    paneKey: 'term-1:leaf-1',
    terminalHandle: 'pty-1',
    worktreeId: 'worktree-1',
    tabId: 'term-1',
    terminalTitle: 'Claude',
    stateHistory: [
      {
        state: 'waiting',
        prompt: 'previous prompt',
        startedAt: 1,
        interrupted: false
      }
    ],
    toolName: 'Read',
    toolInput: 'src/index.ts',
    interactivePrompt: '{"questions":[]}',
    lastAssistantMessage: 'Working on it',
    interrupted: false,
    orchestration: {
      taskId: 'task-1',
      dispatchId: 'dispatch-1',
      taskTitle: 'Scan performance',
      displayName: 'Worker',
      parentTerminalHandle: 'pty-parent',
      parentPaneKey: 'term-parent:leaf-parent',
      coordinatorHandle: 'pty-coordinator',
      orchestrationRunId: 'run-1'
    },
    providerSession: {
      key: 'session_id',
      id: 'session-1',
      transcriptPath: '/tmp/session-1.jsonl'
    }
  }
}

function createTerminalTheme(): MobileTerminalTheme {
  return {
    mode: 'dark',
    theme: {
      foreground: '#eeeeee',
      background: '#111111',
      cursor: '#ffffff',
      brightMagenta: '#ff00ff',
      bold: '#ffffff'
    }
  }
}

describe('mobile terminal record equality', () => {
  it('matches structurally equal fresh status and theme snapshots', () => {
    expect(agentStatusEntriesEqual(createAgentStatus(), createAgentStatus())).toBe(true)
    expect(terminalThemesEqual(createTerminalTheme(), createTerminalTheme())).toBe(true)
  })

  it('detects nested state-history changes', () => {
    const changed = createAgentStatus()
    changed.stateHistory[0]!.interrupted = true

    expect(agentStatusEntriesEqual(createAgentStatus(), changed)).toBe(false)
  })

  it('detects orchestration metadata changes', () => {
    const changed = createAgentStatus()
    changed.orchestration!.coordinatorHandle = 'pty-other-coordinator'

    expect(agentStatusEntriesEqual(createAgentStatus(), changed)).toBe(false)
  })

  it('detects provider-session metadata changes', () => {
    const changed = createAgentStatus()
    changed.providerSession!.transcriptPath = '/tmp/other-session.jsonl'

    expect(agentStatusEntriesEqual(createAgentStatus(), changed)).toBe(false)
  })

  it('detects terminal theme color changes', () => {
    const changed = createTerminalTheme()
    changed.theme.brightMagenta = '#cc00cc'

    expect(terminalThemesEqual(createTerminalTheme(), changed)).toBe(false)
  })

  it('preserves null and undefined snapshot compatibility', () => {
    expect(agentStatusEntriesEqual(null, undefined)).toBe(true)
    expect(terminalThemesEqual(null, undefined)).toBe(true)
    expect(agentStatusEntriesEqual(createAgentStatus(), null)).toBe(false)
    expect(terminalThemesEqual(createTerminalTheme(), undefined)).toBe(false)
  })
})
