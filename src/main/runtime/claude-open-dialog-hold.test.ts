import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { isClaudeDialogHoldingPane } from './claude-open-dialog-hold'

const NOW = 1_000_000_000

function waitingRow(ageMs: number): AgentStatusIpcPayload {
  return {
    paneKey: 'tab:leaf',
    agentType: 'claude',
    state: 'waiting',
    prompt: '',
    connectionId: null,
    receivedAt: NOW - ageMs,
    stateStartedAt: NOW - ageMs
  }
}

// Screens captured from Claude Code 2.1.310.
const PERMISSION = [
  ' Do you want to create hello.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, and switch to accept edits (shift+tab)',
  '   3. No',
  ' Esc to cancel · Tab to amend'
]
const PLAN_APPROVAL = [
  ' Claude has written up a plan and is ready to execute. Would you like to proceed?',
  ' ❯ 1. Yes, and use auto mode',
  '   2. Yes, manually approve edits',
  '   3. Tell Claude what to change',
  ' ctrl+g to edit in Vim · ~/.claude/plans/velvet-jumping-yao.md'
]
const COMPOSER_DRAFT = [
  '❯ 1. fix the flaky test',
  '─'.repeat(40),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
]

function holds(ageMs: number, screen: readonly string[] | null): boolean {
  return isClaudeDialogHoldingPane({
    row: waitingRow(ageMs),
    respawnedAt: undefined,
    readScreenLines: () => screen,
    now: NOW
  })
}

describe('isClaudeDialogHoldingPane', () => {
  it.each([
    ['a permission dialog', PERMISSION, true],
    ['a footerless plan approval', PLAN_APPROVAL, true],
    ['an empty composer left by a dismissed dialog', ['❯ '], false],
    ['a composer draft starting with a number', COMPOSER_DRAFT, false],
    [
      'a dialog scrolled above the bottom region',
      [...PERMISSION, ...Array(20).fill('reply')],
      false
    ]
  ])('reads %s as holding: %s', (_label, screen, expected) => {
    expect(holds(60_000, screen)).toBe(expected)
  })

  it('holds an unreadable screen only until the cap, which also ends a visible dialog hold', () => {
    expect(holds(60_000, null)).toBe(true)
    expect(holds(600_000, null)).toBe(true)
    expect(holds(600_000, PERMISSION)).toBe(true)
    expect(holds(600_001, null)).toBe(false)
    expect(holds(600_001, PERMISSION)).toBe(false)
  })
})
