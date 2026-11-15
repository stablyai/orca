import { afterEach, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentPaneChange } from '../../../agent-hooks/observations/agent-transition-detector'
import { TerminalAgentTurnNews } from './terminal-agent-turn-news'

const paneKey = 'tab:11111111-1111-4111-8111-111111111111'
const workspace = { worktreeId: 'repo::/task', sshHostId: null }

afterEach(() => {
  vi.useRealTimers()
})

it.each([false, true])(
  'delivers an accepted finish after departure unless a new prompt supersedes it (new prompt: %s)',
  (newPrompt) => {
    vi.useFakeTimers()
    let row: AgentStatusIpcPayload | null = {
      paneKey,
      worktreeId: workspace.worktreeId,
      connectionId: null,
      state: 'working',
      agentType: 'claude',
      prompt: 'finish task',
      receivedAt: 1000,
      stateStartedAt: 1000
    }
    const delivered: string[] = []
    const news = new TerminalAgentTurnNews({
      readHookRow: () => row,
      prepare: ({ row: completed }) => completed.lastAssistantMessage ?? '',
      deliver: (message) => delivered.push(message),
      setTimer: (run, delayMs) => {
        const timer = setTimeout(run, delayMs)
        return { cancel: () => clearTimeout(timer) }
      }
    })
    const observe = (
      from: Extract<AgentPaneChange, { kind: 'moved' }>['from'],
      to: Extract<AgentPaneChange, { kind: 'moved' }>['to'],
      transition: Extract<AgentPaneChange, { kind: 'moved' }>['transition']
    ) => news.observe({ kind: 'moved', paneKey, workspace, from, to, transition, at: 2000 })
    try {
      news.observe({ kind: 'observed', paneKey, workspace, phase: 'working', at: 1000 })
      row = { ...row, state: 'done', stateStartedAt: 2000, lastAssistantMessage: 'Finished.' }
      observe('working', 'done', 'turn-finished')
      row = null
      observe('done', 'rest', null)
      if (newPrompt) {
        observe('rest', 'working', 'prompt-submitted')
      }
      vi.runAllTimers()
      expect(delivered).toEqual(newPrompt ? [] : ['Finished.'])
      vi.runAllTimers()
      expect(delivered).toEqual(newPrompt ? [] : ['Finished.'])
    } finally {
      news.dispose()
    }
  }
)
