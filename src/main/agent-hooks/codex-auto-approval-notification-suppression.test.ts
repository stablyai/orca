import { describe, expect, it } from 'vitest'
import { AUTO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ARGS } from '../../shared/tui-agent-permissions'
import { shouldSuppressCodexAutoApprovalSyntheticTitleFromHook } from './codex-auto-approval-notification-suppression'

describe('Codex hook auto-approval notification suppression', () => {
  it('suppresses yolo waiting and blocked statuses', () => {
    const launchConfig = { agentArgs: YOLO_TUI_AGENT_ARGS.codex, agentEnv: {} }

    expect(
      shouldSuppressCodexAutoApprovalSyntheticTitleFromHook({
        agentType: 'codex',
        state: 'waiting',
        launchConfig
      })
    ).toBe(true)
    expect(
      shouldSuppressCodexAutoApprovalSyntheticTitleFromHook({
        agentType: 'codex',
        state: 'blocked',
        launchConfig
      })
    ).toBe(true)
  })

  it('keeps approve-for-me auto waits visible for high-risk permission requests', () => {
    expect(
      shouldSuppressCodexAutoApprovalSyntheticTitleFromHook({
        agentType: 'codex',
        state: 'waiting',
        launchConfig: { agentArgs: AUTO_TUI_AGENT_ARGS.codex, agentEnv: {} }
      })
    ).toBe(false)
  })

  it('keeps request_user_input waits visible under yolo attribution', () => {
    expect(
      shouldSuppressCodexAutoApprovalSyntheticTitleFromHook({
        agentType: 'codex',
        state: 'waiting',
        toolName: 'request_user_input',
        launchConfig: { agentArgs: YOLO_TUI_AGENT_ARGS.codex, agentEnv: {} }
      })
    ).toBe(false)
  })

  it('fails open for unrelated statuses or missing attribution', () => {
    expect(
      shouldSuppressCodexAutoApprovalSyntheticTitleFromHook({
        agentType: 'claude',
        state: 'waiting',
        launchConfig: { agentArgs: YOLO_TUI_AGENT_ARGS.codex, agentEnv: {} }
      })
    ).toBe(false)
    expect(
      shouldSuppressCodexAutoApprovalSyntheticTitleFromHook({
        agentType: 'codex',
        state: 'done',
        launchConfig: { agentArgs: YOLO_TUI_AGENT_ARGS.codex, agentEnv: {} }
      })
    ).toBe(false)
    expect(
      shouldSuppressCodexAutoApprovalSyntheticTitleFromHook({
        agentType: 'codex',
        state: 'waiting',
        launchConfig: null
      })
    ).toBe(false)
  })
})
