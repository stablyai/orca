import type { HookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import { MAX_PANE_KEY_LEN } from '../../../shared/agent-hook-listener/listener-limits'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { bindJcodeRootSession } from '../../../shared/agent-hook-listener/jcode-session-registry'
import {
  clearReplacedJcodeRoot,
  prepareJcodeState
} from '../../../shared/agent-hook-listener/jcode-prepared-state'
import { saveJcodeRootPayload } from '../../../shared/agent-hook-listener/providers/jcode-roster-state'

export type LaunchResumeIdentity = {
  paneKey: string
  worktreeId?: string
  agentType: string
  providerSession: AgentProviderSessionMetadata
  /** When the pane's process launched; a row reported since then is the agent's own. */
  launchedAt: number
}

export function prepareLaunchResumeIdentity(
  state: HookListenerState,
  event: LaunchResumeIdentity
): { event: AgentHookEventPayload; onCommitted?: () => void } | undefined {
  const paneKey = event.paneKey
  const parsedPaneKey = parsePaneKey(paneKey)
  if (!parsedPaneKey || paneKey.length > MAX_PANE_KEY_LEN) {
    return
  }
  const previous = state.lastStatusByPaneKey.get(paneKey)
  if (
    previous &&
    (previous.providerSessionOnly === true
      ? agentProviderSessionsEqual(
          event.agentType,
          previous.providerSession,
          event.providerSession
        ) ||
        (event.agentType === 'jcode' &&
          'receivedAt' in previous &&
          typeof previous.receivedAt === 'number' &&
          previous.receivedAt >= event.launchedAt)
      : 'receivedAt' in previous &&
        typeof previous.receivedAt === 'number' &&
        previous.receivedAt >= event.launchedAt)
  ) {
    return
  }
  const identity: AgentHookEventPayload &
    Pick<EnrichedAgentHookEventPayload, 'retainedForLiveness'> = {
    paneKey,
    tabId: parsedPaneKey.tabId,
    ...(event.worktreeId?.trim() ? { worktreeId: event.worktreeId.trim() } : {}),
    connectionId: null,
    providerSession: event.providerSession,
    providerSessionOnly: true,
    // Hydration must retain this identity even if no first turn occurs before restart.
    retainedForLiveness: true,
    payload: { state: 'done', prompt: '', agentType: event.agentType }
  }
  let onCommitted: (() => void) | undefined
  if (event.agentType === 'jcode') {
    if (event.providerSession.key !== 'session_id') {
      return
    }
    const prepared = prepareJcodeState(state, paneKey)
    if (!bindJcodeRootSession(prepared.draft, paneKey, event.providerSession.id, 'launch')) {
      return
    }
    clearReplacedJcodeRoot(prepared.draft, paneKey, event.providerSession.id)
    saveJcodeRootPayload(prepared.draft, paneKey, identity.payload)
    onCommitted = prepared.commit
  }
  return { event: identity, onCommitted }
}
