import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchExecution } from './agent-launch-executor'
import type { AgentLaunchModeReceipt } from './agent-launch-mode'
import type { AgentLaunchSurfaceFactory } from './agent-launch-surface-factories'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the execution's type is checked; nothing runs it.
const runtime = {} as AgentLaunchExecution['runtime']
const decidedMode: AgentLaunchModeReceipt = {
  mode: 'terminal',
  preferred: 'terminal',
  reason: 'user_default',
  detail: 'Started a terminal agent, the default for new agent tabs in your settings.'
}

describe('a caller-decided launch mode', () => {
  it('cannot be combined with the pre-flight inputs it replaces', () => {
    const intent = {
      agent: 'claude' as const,
      target: { kind: 'existing' as const, worktree: 'wt' }
    }
    const surfaces: AgentLaunchSurfaceFactory = {
      createStructuredSession: vi.fn(),
      createTerminalAgent: vi.fn()
    }
    const accepts = (execution: AgentLaunchExecution) => execution
    // @ts-expect-error a decided mode already settled what terminalOnly would force
    accepts({ runtime, intent, surfaces, decidedMode, terminalOnly: true })
    // @ts-expect-error a decided mode already settled what the caller's chat support would downgrade
    accepts({ runtime, intent, surfaces, decidedMode, callerRendersStructured: false })
    expect(accepts({ runtime, intent, surfaces, decidedMode }).decidedMode).toBe(decidedMode)
    expect(accepts({ runtime, intent, surfaces, terminalOnly: true }).terminalOnly).toBe(true)
  })
})
