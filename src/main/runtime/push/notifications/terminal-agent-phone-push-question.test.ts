import { expect, it } from 'vitest'
import type { AgentPaneChange } from '../../../agent-hooks/agent-transition-detector'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { getDefaultNotificationSettings } from '../../../../shared/notification-settings-defaults'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'
import '../../../notifications/notification-delivery-service'
import { TerminalAgentPhonePush } from './terminal-agent-phone-push'

it('applies question-only preferences to headless phone delivery using the observed tool', () => {
  const worktreeId = 'repo-1::/tmp/wt'
  const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
  let now = 10_000
  let hookRow: AgentStatusIpcPayload = {
    state: 'waiting',
    prompt: 'fix the bug',
    agentType: 'claude',
    paneKey,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 5_000,
    toolName: 'Bash'
  }
  const sent: MobileNotificationDispatchEvent[] = []
  const push = new TerminalAgentPhonePush({
    hasWindow: () => false,
    readNotificationSettings: () => ({
      ...getDefaultNotificationSettings(),
      enabled: true,
      agentQuestionsOnly: true
    }),
    readWorkspaceLabels: () => ({ repoLabel: 'orca', worktreeLabel: 'feature' }),
    isWorkspaceMuted: () => false,
    readOrchestration: () => undefined,
    readTerminalTitle: () => null,
    readHookRow: () => hookRow,
    dispatch: (event) => sent.push(event),
    setTimer: () => ({ cancel: () => {} }),
    now: () => now
  })
  const change: AgentPaneChange = {
    kind: 'moved',
    paneKey,
    workspace: { worktreeId, sshHostId: null },
    from: 'working',
    to: 'needs-you',
    at: 1,
    transition: 'needs-input'
  }
  push.observe(change)
  now += 5_000
  hookRow = { ...hookRow, toolName: 'AskUserQuestion', stateStartedAt: 10_000 }
  push.observe(change)
  expect(sent.map((event) => event.desktopAllowed !== false)).toEqual([false, true])
})
