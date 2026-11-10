import { describe, expect, it } from 'vitest'
import { acpPermissionPresentation } from '../../../../acp/requests/acp-timeline-requests'
import { codexApprovalItem } from '../../../../codex/structured/prompts/codex-structured-prompt-items'
import { CODEX_MCP_ELICITATION_METHOD } from '../../../../codex/structured/prompts/codex-prompt-registry'
import { claudeApprovalItem } from '../../../../claude/structured/journal/claude-structured-prompt-items'
import type { AgentJournalPromptOption } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { chatAnswerOutcome, workerApprovalOption } from './worker-approval'

function acpOptions(kinds: string[]): AgentJournalPromptOption[] {
  const body = acpPermissionPresentation({
    sessionId: 's',
    toolCall: { toolCallId: 't', title: 'Run a command' },
    options: kinds.map((kind, index) => ({ optionId: `opt_${index}`, name: kind, kind }))
  }).body
  return body.kind === 'approval' ? body.options : []
}

const pick = (options: AgentJournalPromptOption[], decision: 'allow' | 'deny') =>
  workerApprovalOption(options, decision)?.id ?? null

describe('worker approval option', () => {
  it("picks each agent's own refuse-once option for a deny", () => {
    const claude = claudeApprovalItem({
      requestId: 'r',
      promptKey: 'p',
      toolUseId: 't',
      toolName: 'Bash',
      kind: 'approval',
      input: { command: 'ls' },
      suggestions: [],
      questionIds: [],
      settle: () => {}
    }).options
    const codexCommand = codexApprovalItem({
      method: 'item/commandExecution/requestApproval',
      params: { availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] },
      detail: 'ls'
    }).options
    const codexMcp = codexApprovalItem({
      method: CODEX_MCP_ELICITATION_METHOD,
      params: { message: 'Allow?' },
      detail: null
    }).options

    expect(pick(claude, 'deny')).toBe('deny')
    expect(pick(codexCommand, 'deny')).toBe('decline')
    // MCP cancel skips only this call, so it is the refuse-once option there.
    expect(pick(codexMcp, 'deny')).toBe('cancel')
    expect(pick(acpOptions(['allow_once', 'allow_always', 'reject_once']), 'deny')).toBe('opt_2')
  })

  it('never answers a deny with an allow, a standing rule or a stop', () => {
    expect(pick(acpOptions(['allow_once', 'allow_always', 'reject_always']), 'deny')).toBeNull()
    expect(pick(acpOptions(['allow_once', 'allow_always']), 'deny')).toBeNull()
    // Codex without decline offers only allow or stop the turn.
    const codexNoDecline = codexApprovalItem({
      method: 'item/commandExecution/requestApproval',
      params: { availableDecisions: ['accept', 'cancel'] },
      detail: 'ls'
    }).options
    expect(pick(codexNoDecline, 'deny')).toBeNull()
    // Two refuse-once options would be a guess.
    expect(pick(acpOptions(['reject_once', 'reject_once']), 'deny')).toBeNull()
  })

  it('allows only once, never for the session', () => {
    expect(pick(acpOptions(['allow_always', 'reject_once']), 'allow')).toBeNull()
    expect(pick(acpOptions(['allow_once', 'allow_always', 'reject_once']), 'allow')).toBe('opt_0')
  })
})

describe('chat answer outcome', () => {
  it('tells a reason only when it went to the worker as mail', () => {
    expect(
      chatAnswerOutcome({ by: 'person', decision: 'allow', reason: 'ok', reasonMailed: false })
    ).toEqual({ by: 'person', decision: 'allow', reason: null, reasonDelivered: false })
    expect(
      chatAnswerOutcome({
        by: 'coordinator',
        decision: 'deny',
        reason: 'use a script file',
        reasonMailed: true
      })
    ).toEqual({
      by: 'coordinator',
      decision: 'deny',
      reason: 'use a script file',
      reasonDelivered: false
    })
  })
})
