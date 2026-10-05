import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY,
  type RuntimeCapability
} from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import {
  conversationIsOfferedWithoutStatus,
  readTerminalConversationIdentity
} from '../../../../shared/terminal-conversation-identity'

type SessionTabsPayload = RuntimeMobileSessionTabsResult | RuntimeMobileSessionTabsSnapshot

function terminalPaneKey(parentTabId: string, leafId: string): string {
  if (isTerminalLeafId(leafId)) {
    return makePaneKey(parentTabId, leafId)
  }
  const legacyPaneId = /^pane:(\d+)$/.exec(leafId)?.[1] ?? null
  return `${parentTabId}:${legacyPaneId ?? leafId}`
}

/**
 * Shipped phones read a conversation only from `agentStatus`, so for them an offered statusless
 * identity becomes a completion-neutral `done` boundary. Delete once capability-less phones are
 * unsupported; paired desktops never get it, because they replace their completion rows with it.
 */
export function foldConversationIdentityForLegacyPhones<TPayload extends SessionTabsPayload>(
  payload: TPayload,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): TPayload {
  if (
    clientKind !== 'mobile' ||
    clientCapabilities?.includes(TERMINAL_CONVERSATION_IDENTITY_CLIENT_CAPABILITY)
  ) {
    return payload
  }
  let changed = false
  const tabs = payload.tabs.map((tab) => {
    if (tab.type !== 'terminal' || !conversationIsOfferedWithoutStatus(tab)) {
      return tab
    }
    const offered = readTerminalConversationIdentity(tab.conversationIdentity)
    if (!offered) {
      return tab
    }
    changed = true
    const agentStatus: AgentStatusEntry = {
      state: 'done',
      sessionBoundary: true,
      prompt: '',
      // Why the capture clock: a same-status repaint must not advance the fold or emit a frame.
      updatedAt: offered.capturedAt,
      stateStartedAt: offered.capturedAt,
      stateHistory: [],
      paneKey: terminalPaneKey(tab.parentTabId, tab.leafId),
      tabId: tab.parentTabId,
      terminalTitle: tab.title,
      agentType: offered.agentType,
      providerSession: offered.providerSession,
      ...(offered.model ? { model: offered.model } : {}),
      ...(offered.modelSwitchCommand ? { modelSwitchCommand: offered.modelSwitchCommand } : {}),
      ...('terminal' in tab && typeof tab.terminal === 'string'
        ? { terminalHandle: tab.terminal }
        : {}),
      ...(payload.worktree ? { worktreeId: payload.worktree } : {})
    }
    // Why drop the members: shipped phones never read them; the fold carries the address.
    const {
      conversationIdentity: _conversationIdentity,
      conversationOfferedWithoutStatus: _offered,
      ...folded
    } = tab
    return { ...folded, agentStatus }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only terminal tabs gained a status; every other member of the payload is unchanged.
  return changed ? ({ ...payload, tabs } as TPayload) : payload
}
