import { describe, expect, it } from 'vitest'
import { structuredAgentSessionStatusPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-tab'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { mobileBotRowLine, mobileBotRowLineText } from './mobile-bot-row-line'

const NOW = 1_000_000_000_000

function row(
  sessionId: string,
  overrides: Partial<RuntimeWorktreeAgentRow> = {}
): RuntimeWorktreeAgentRow {
  return {
    paneKey: structuredAgentSessionStatusPaneKey(sessionId),
    parentPaneKey: null,
    state: 'done',
    agentType: 'claude',
    prompt: 'the ask',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...overrides
  }
}

const slackThread = {
  source: 'slack' as const,
  sessionId: 'thread-1',
  paneKey: structuredAgentSessionStatusPaneKey('thread-1'),
  place: '#ui-ux-design',
  lastTurn: 'conversation' as const
}

function lineText(rows: RuntimeWorktreeAgentRow[], waits: { label: string }[] = []) {
  const line = mobileBotRowLine(
    { paused: false, line: { chatSessionId: 'home-chat', links: [slackThread], waits } },
    rows,
    NOW
  )
  return line ? mobileBotRowLineText(line, NOW) : null
}

describe('mobileBotRowLine', () => {
  it("says what the bot's newest Chat or thread turn said, naming the thread's place", () => {
    expect(
      lineText([
        row('home-chat', { lastAssistantMessage: 'Filed 2 bug reports', updatedAt: NOW - 5_000 }),
        row('thread-1', { lastAssistantMessage: 'Asked about the invite', updatedAt: NOW - 1_000 })
      ])
    ).toBe('#ui-ux-design · Asked about the invite')
  })

  it('names its wait while nothing works, and counts other home sessions only while they work', () => {
    expect(lineText([row('automation-run')], [{ label: "Nora's reply" }])).toBe(
      "Waiting for Nora's reply"
    )
    expect(
      lineText([row('automation-run', { state: 'working' })], [{ label: "Nora's reply" }])
    ).toBe('1 working')
  })
})
