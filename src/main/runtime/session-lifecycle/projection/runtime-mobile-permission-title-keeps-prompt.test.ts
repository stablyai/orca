import { describe, expect, it } from 'vitest'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from './runtime-mobile-agent-status-projection'
import { makeTuiIdlePty } from '../../terminal/wait/tui-idle-wait-test-harness'

const approval = JSON.stringify({ approval: { tool: 'Bash', summary: 'kubectl get nodes' } })

describe('a permission title after the PermissionRequest hook', () => {
  it('keeps the approval prompt the hook published', () => {
    const hookAt = Date.now() - 2_000
    const titleAt = hookAt + 500
    const out = renewRuntimeMobileAgentStatusFromPtyTitle(
      {
        state: 'waiting',
        prompt: 'check the cluster',
        updatedAt: hookAt,
        stateStartedAt: hookAt,
        agentType: 'claude',
        paneKey: 'tab-1:leaf-1',
        stateHistory: [],
        toolName: 'Bash',
        toolInput: 'kubectl get nodes',
        interactivePrompt: approval
      },
      makeTuiIdlePty({
        lastOscTitle: 'Claude Code',
        lastOscTitleEpochMs: titleAt,
        lastAgentStatus: 'permission',
        lastAgentStatusStartedAtEpochMs: titleAt,
        // The title moved from working to permission after the hook, as Claude paints it.
        lastAgentStatusRichInvalidatedAtEpochMs: titleAt
      })
    )
    expect(out).toMatchObject({
      state: 'waiting',
      toolName: 'Bash',
      interactivePrompt: approval
    })
  })
})
