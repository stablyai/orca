import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS } from '../../../src/shared/agent-session/agent-session-conversation-command'
import { AGENT_SESSION_PHONE_REWIND_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/agent-session-runtime-capabilities'
import type { AgentSessionRewindResult } from '../../../src/shared/agent-session/lifecycle/agent-session-rewind'
import {
  createAgentSessionRewindHook,
  type AgentSessionRewindInput,
  type AgentSessionRewindSendOutcome
} from '../../../src/shared/agent-session/lifecycle/agent-session-rewind-request'
import type { StructuredAgentSessionState } from '../../../src/shared/agent-session/structured-agent-session-reducer'
import { actionableStructuredPrompts } from './mobile-structured-actionable-prompt'
import { useRouteRelaysCapability } from '../worktree/workspace-server-context'
import { sayMobileNativeChatRewind } from './native-chat/mobile-native-chat-rewind-copy'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import { requestStructuredAgentSessionMutation } from './mobile-structured-agent-session-rpc'
import { returnMobileNativeChatMessageToComposer } from './mobile-native-chat-message-hand-back'
import type { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import type { MobileStructuredAgentSessionArgs } from './mobile-structured-agent-session-contract'
import type { MobileStructuredBackgroundTasks } from './use-mobile-structured-background-tasks'
import type { MobileStructuredSendsOut } from './use-mobile-structured-stop-offer'
import { tuiAgentDisplayName } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'

const useAgentSessionRewind = createAgentSessionRewindHook(
  { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState },
  sayMobileNativeChatRewind
)
const presentation = () => () => true

/** Desktop's "Rewind to here" for a phone chat, and the chat's send held while a rewind settles. */
export function useMobileStructuredAgentRewind<A extends unknown[]>(
  args: Pick<
    MobileStructuredAgentSessionArgs,
    'client' | 'sessionId' | 'enabled' | 'connected' | 'hostSupport' | 'agent' | 'composerScopeKey'
  > & {
    onSendError: (text: string) => void
    state: StructuredAgentSessionState
    stateRef: { readonly current: StructuredAgentSessionState }
    options: Pick<
      ReturnType<typeof useMobileStructuredAgentOptions>,
      'rewindSupport' | 'rewindBlockedReason'
    >
    turnId: string | null
    backgroundTasks: MobileStructuredBackgroundTasks
    sendsOut: MobileStructuredSendsOut
    commandPendingRef: { readonly current: boolean }
    queuedMessages: readonly unknown[] | null
    send: (...input: A) => Promise<MobileNativeChatSendOutcome>
  }
) {
  const { client, composerScopeKey, onSendError: notify, sessionId, state, stateRef } = args
  const { connected } = args
  const enabled = args.enabled && connected
  const agentName = args.agent ? (tuiAgentDisplayName(args.agent) ?? args.agent) : undefined
  const { rewindSupport, rewindBlockedReason } = args.options
  const forwarded = useRouteRelaysCapability(AGENT_SESSION_PHONE_REWIND_RUNTIME_CAPABILITY)
  const offered = args.hostSupport?.phoneRewind === true && forwarded
  // Desktop's busy facts: the host refuses a rewind behind any of them, queued cards included.
  const blocked =
    args.turnId !== null ||
    args.backgroundTasks.view.isMonitoring ||
    actionableStructuredPrompts(state).length > 0 ||
    args.sendsOut.sending() ||
    args.commandPendingRef.current ||
    (args.queuedMessages?.length ?? 0) > 0
  const rewindSend = useCallback(
    async (fields: {
      itemId: string
      expectedEpoch: string
    }): Promise<AgentSessionRewindSendOutcome> => {
      const fence = stateRef.current.fence
      if (!client || !sessionId || !enabled || fence === null) {
        return { kind: 'dropped' }
      }
      const result = await requestStructuredAgentSessionMutation<AgentSessionRewindResult>({
        client,
        method: 'agentSession.rewind',
        fingerprintMethod: 'agentSession.rewind',
        sessionId,
        expectedRuntimeFence: fence,
        fields,
        // The host may start an agent at rest before rewinding it, as it does for a command.
        timeoutMs: AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS,
        ...(agentName ? { agentName } : {})
      })
      return result.status === 'accepted'
        ? { kind: 'done', value: result.value }
        : {
            kind: 'not-done',
            failure: result.status === 'unknown' ? { kind: 'unconfirmed' } : result.failure
          }
    },
    [agentName, client, enabled, sessionId, stateRef]
  )
  const input = useMemo<AgentSessionRewindInput>(
    () => ({
      sessionId: sessionId ?? '',
      capturePresentation: presentation,
      ...(composerScopeKey
        ? {
            returnToComposer: (itemId, blocks) =>
              returnMobileNativeChatMessageToComposer(composerScopeKey, `rewound-${itemId}`, blocks)
          }
        : {}),
      // A dropped link (the app in the background) reads nothing, so a late reset isn't a failure.
      isVisible: connected,
      state,
      contextFloor: rewindSupport?.contextFloor,
      support: offered && enabled ? rewindSupport?.support : undefined,
      hostBlockedReason: rewindBlockedReason,
      blocked,
      send: rewindSend,
      notify: { error: notify, message: notify }
    }),
    [
      blocked,
      connected,
      composerScopeKey,
      enabled,
      notify,
      offered,
      rewindBlockedReason,
      rewindSend,
      rewindSupport,
      sessionId,
      state
    ]
  )
  const { admitsSend, surface } = useAgentSessionRewind(input)
  const { send } = args
  const sendWithOutcome = useCallback(
    (...sent: A): Promise<MobileNativeChatSendOutcome> =>
      admitsSend() ? send(...sent) : Promise.resolve('rejected'),
    [admitsSend, send]
  )
  return { rewind: surface, sendWithOutcome }
}
