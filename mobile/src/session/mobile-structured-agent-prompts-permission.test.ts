import { describe, expect, it } from 'vitest'
import {
  projectStructuredPermission,
  type StructuredApprovalItem
} from './mobile-structured-agent-prompts'

function approvalPrompt(): StructuredApprovalItem {
  return {
    itemId: 'approval-1',
    revision: 2,
    sequence: 1,
    observedAt: 0,
    body: {
      kind: 'approval',
      title: 'Claude wants to run git push',
      decisionReason: 'Pushing changes the remote',
      blockedPath: 'C:\\qa\\demo\\.git\\config',
      matchedAskRule: {
        source: 'projectSettings',
        toolName: 'Bash',
        ruleContent: 'Bash(git push:*)'
      },
      detail: 'git push origin main',
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
}

describe('structured permission projection', () => {
  it('carries the blocked path to the card but not the matched ask rule', () => {
    const permission = projectStructuredPermission(approvalPrompt())
    expect(permission).toMatchObject({
      decisionReason: 'Pushing changes the remote',
      blockedPath: 'C:\\qa\\demo\\.git\\config',
      detail: 'git push origin main'
    })
    expect(permission).not.toHaveProperty('matchedAskRule')
  })
})
