import { describe, expect, it } from 'vitest'
import { AGENT_CHAT_PERMISSION_MODES } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { codexStructuredPermissionPolicy } from '../../../../shared/agent-launch/permissions/codex-permission-policy'
import { reportedCodexPermissionMode } from './codex-structured-thread-open'

describe('reportedCodexPermissionMode', () => {
  // Orca's Ask is read-only, so naming a writable workspace Ask would promise prompts that never come.
  it.each([{ type: 'workspaceWrite', writableRoots: ['/configured'] }, 'workspace-write'])(
    'names no mode for a writable workspace that asks on request: %o',
    (sandbox) => {
      expect(
        reportedCodexPermissionMode({
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox
        })
      ).toBeNull()
    }
  )

  it('names a mode only for the policy that mode runs', () => {
    for (const mode of AGENT_CHAT_PERMISSION_MODES) {
      const { sandbox, ...policy } = codexStructuredPermissionPolicy(mode)
      const named = reportedCodexPermissionMode({ ...policy, sandbox })
      // Codex has no edits-only mode, so Accept edits runs as Ask.
      expect(named).toBe(mode === 'accept-edits' ? 'ask' : mode)
    }
  })
})
