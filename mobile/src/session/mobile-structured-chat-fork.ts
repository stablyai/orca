import { translate } from '../i18n/mobile-i18n'
import { triggerError } from '../platform/haptics/haptics'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import type {
  StructuredAgentSessionCreateParams,
  StructuredAgentSessionForkSource
} from '../../../src/shared/agent-session/structured-agent-session-create'
import { AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/agent-session-create-capabilities'
import { createMobileStructuredAgentSession } from './native-chat/agent-session/mobile-structured-agent-session-launch'
import {
  launchedSelection,
  withLaunchReply,
  withoutUnansweredLaunch
} from './tabs/pending-session-selection'
import { releaseTerminalCreateLock } from '../terminal/session/creation/terminal-create-lock'
import type { MobileSessionAttachmentsModel } from '../files/attachments/use-mobile-session-attachments'

type ForkScope = Pick<
  MobileSessionAttachmentsModel,
  | 'client'
  | 'worktreeId'
  | 'creatingTerminalRef'
  | 'setCreating'
  | 'pendingSelectionRef'
  | 'fetchSessionTabs'
  | 'showToast'
  | 'hostCapabilities'
  | 'sessionTabsRef'
>

/** Right after the source chat's tab, read before anything awaits so a later tab switch can't move it.
 *  The host finds the tab's group; a missing anchor falls back to its usual place. */
export function mobileChatForkTabPlacement(
  scope: Pick<ForkScope, 'hostCapabilities' | 'sessionTabsRef'>,
  sourceSessionId: string
): StructuredAgentSessionCreateParams['tabPlacement'] {
  if (!scope.hostCapabilities?.includes(AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY)) {
    return undefined
  }
  const source = scope.sessionTabsRef.current.find(
    (tab) => tab.type === 'agent-session' && tab.sessionId === sourceSessionId
  )
  return source ? { afterTabId: source.id } : undefined
}

/** Creates the fork through the phone's ordinary chat create and selects it; the source is untouched.
 *  Resolves once the outcome is known, so the caller's action stays disabled until then. */
export async function forkMobileStructuredChat(
  scope: ForkScope,
  agent: TuiAgent,
  forkFrom: StructuredAgentSessionForkSource
): Promise<void> {
  const agentName = TUI_AGENT_DISPLAY_NAMES[agent]
  const report = (message: string): void => {
    triggerError()
    scope.showToast(message, 3000)
  }
  const { client } = scope
  const tabPlacement = mobileChatForkTabPlacement(scope, forkFrom.sessionId)
  if (!client || scope.creatingTerminalRef.current) {
    report(mobileChatForkCopy.busy(agentName))
    return
  }
  const lock = `mobile-fork:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  scope.creatingTerminalRef.current = lock
  scope.setCreating(true)
  // Arm before requesting so later user tab picks supersede the fork.
  scope.pendingSelectionRef.current = launchedSelection(lock, {}, null)
  try {
    const result = await createMobileStructuredAgentSession(
      client,
      scope.worktreeId,
      agent,
      forkFrom,
      tabPlacement
    )
    if (result.kind === 'created') {
      scope.pendingSelectionRef.current = withLaunchReply(scope.pendingSelectionRef.current, lock, {
        sessionId: result.sessionId
      })
      void scope.fetchSessionTabs()
    } else if (result.kind === 'unknown') {
      report(mobileChatForkCopy.unconfirmed(agentName))
    } else {
      report(
        mobileChatForkCopy.failed(
          agentName,
          result.kind === 'failed' ? result.message : mobileChatForkCopy.unsupported()
        )
      )
    }
  } catch {
    report(mobileChatForkCopy.unconfirmed(agentName))
  } finally {
    scope.pendingSelectionRef.current = withoutUnansweredLaunch(
      scope.pendingSelectionRef.current,
      lock
    )
    releaseTerminalCreateLock(scope, lock)
  }
}

const mobileChatForkCopy = {
  busy: (agent: string) =>
    translate(
      'chat.fork.busy',
      'Another chat or terminal is opening. Wait, then fork the {{agent}} chat again.',
      { agent }
    ),
  unconfirmed: (agent: string) =>
    translate(
      'chat.fork.unconfirmed',
      "{{agent}} couldn't confirm the fork. It may have opened anyway; check Session History before forking again.",
      { agent }
    ),
  failed: (agent: string, detail: string) =>
    translate('chat.fork.failed', "{{agent}} couldn't fork this chat. {{detail}}", {
      agent,
      detail
    }),
  unsupported: () =>
    translate(
      'chat.fork.unsupported',
      'This host runs an older Orca. Update Orca on the host, then try again.'
    )
}
