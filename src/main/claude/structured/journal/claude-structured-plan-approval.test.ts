import { describe, expect, it, vi } from 'vitest'
import { claudeApprovalItem } from './claude-structured-prompt-items'
import { buildClaudePromptReply } from './claude-structured-prompt-replies'
import { leaveClaudePlanModeOnApproval } from '../permissions/claude-plan-approval-mode'
import type { ClaudePendingPrompt } from '../permissions/claude-prompt-registry'

function planPrompt(overrides: Partial<ClaudePendingPrompt> = {}): ClaudePendingPrompt {
  return {
    requestId: 'req-plan',
    promptKey: 'req-plan',
    toolUseId: 'toolu-plan',
    toolName: 'ExitPlanMode',
    kind: 'approval',
    input: { plan: '1. Add tests' },
    subject: { kind: 'plan', text: '1. Add tests', filePath: '/workspace/plan.md' },
    suggestions: [],
    questionIds: [],
    settle: vi.fn(),
    ...overrides
  }
}

describe('Claude plan approval choices and feedback', () => {
  it('offers base-mode-aware A/B/C options and multiline freeTextInput for ExitPlanMode', () => {
    expect(claudeApprovalItem(planPrompt(), 'default')).toMatchObject({
      options: [
        { id: 'allowAcceptEdits', label: 'Approve and auto-accept edits', intent: 'allow_always' },
        { id: 'allow', label: 'Approve and ask before edits', intent: 'allow_once' },
        { id: 'deny', label: 'Keep planning', intent: 'reject_once' }
      ],
      freeTextInput: { multiline: true }
    })

    expect(claudeApprovalItem(planPrompt(), 'acceptEdits').options).toEqual([
      { id: 'allow', label: 'Approve and auto-accept edits', intent: 'allow_once' },
      { id: 'allowAsk', label: 'Approve and ask before edits', intent: 'allow_always' },
      { id: 'deny', label: 'Keep planning', intent: 'reject_once' }
    ])

    expect(claudeApprovalItem(planPrompt(), 'bypassPermissions').options).toEqual([
      { id: 'allow', label: 'Approve plan', intent: 'allow_once' },
      { id: 'allowAcceptEdits', label: 'Approve and auto-accept edits', intent: 'allow_always' },
      { id: 'deny', label: 'Keep planning', intent: 'reject_once' }
    ])

    const bashItem = claudeApprovalItem(
      planPrompt({
        toolName: 'Bash',
        subject: undefined,
        input: { command: 'ls' }
      }),
      'default'
    )
    expect(bashItem.freeTextInput).toBeUndefined()
    expect(bashItem.options.map((option) => option.id)).toEqual([
      'allow',
      'allowForSession',
      'deny'
    ])
  })

  it('builds allow replies for secondary plan modes and forwards trimmed revision feedback on deny', () => {
    const prompt = planPrompt()
    expect(
      buildClaudePromptReply(prompt, { kind: 'option', optionId: 'allowAcceptEdits' })
    ).toMatchObject({ behavior: 'allow', toolUseID: 'toolu-plan' })
    expect(buildClaudePromptReply(prompt, { kind: 'option', optionId: 'allowAsk' })).toMatchObject({
      behavior: 'allow',
      toolUseID: 'toolu-plan'
    })
    expect(
      buildClaudePromptReply(prompt, {
        kind: 'option',
        optionId: 'deny',
        feedback: '  Keep auth synchronous  '
      })
    ).toEqual({
      behavior: 'deny',
      message: 'Keep auth synchronous',
      toolUseID: 'toolu-plan'
    })
    expect(
      buildClaudePromptReply(prompt, {
        kind: 'option',
        optionId: 'deny',
        feedback: '   '
      })
    ).toEqual({
      behavior: 'deny',
      message: 'The user asked you to keep planning. Revise the plan and call ExitPlanMode again.',
      toolUseID: 'toolu-plan'
    })
  })

  it('switches to the chosen build permission mode and updates buildPermissionMode on approval', async () => {
    const setPermissionMode = vi.fn(async () => {})
    const appliedInputOptions = new Map<string, string>()
    const session = {
      launchIntent: { permissionMode: 'default' as const },
      firstRootInit: { permissionMode: 'plan' as const },
      reportedOptions: { reportedPermissionMode: 'plan' as const },
      orderedPermissionMode: () => 'plan' as const,
      appliedInputOptions,
      connection: { setPermissionMode }
    }
    const prompt = { toolName: 'ExitPlanMode' }
    const allowReply = { behavior: 'allow' as const, updatedInput: {} }

    leaveClaudePlanModeOnApproval(session, prompt, allowReply, {
      kind: 'option',
      optionId: 'allowAcceptEdits'
    })
    expect(setPermissionMode).toHaveBeenCalledWith('acceptEdits')
    await Promise.resolve()
    expect(appliedInputOptions.get('buildPermissionMode')).toBe('acceptEdits')

    leaveClaudePlanModeOnApproval(session, prompt, allowReply, {
      kind: 'option',
      optionId: 'allowAsk'
    })
    expect(setPermissionMode).toHaveBeenCalledWith('default')
    await Promise.resolve()
    expect(appliedInputOptions.get('buildPermissionMode')).toBe('default')
  })
})
