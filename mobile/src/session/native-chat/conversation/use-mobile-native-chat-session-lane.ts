import { useCallback } from 'react'
import type { MobileSessionItemLink } from '../../mobile-session-item-target'
import type { MobileComposerWriter } from '../composer/drafts/mobile-native-chat-draft-store'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { useMobileWorkerApprovals } from '../input/prompts/use-mobile-worker-approvals'
import { useMobilePairedServerAsks } from '../input/prompts/use-mobile-paired-server-asks'
import type { MobileNativeChatController } from '../mobile-native-chat-controller-contract'
import type { StructuredAgentSessionHostSupport } from '../agent-session/mobile-structured-agent-session-host-support'
import type { ConnectionState } from '../../../transport/connection/connection-state'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileStructuredAgentSession } from '../agent-session/use-mobile-structured-agent-session'
import { useMobileStructuredSessionCommands } from '../composer/commands/use-mobile-structured-session-commands'
import type { MobileNativeChatResolution } from './mobile-native-chat-eligibility'
import type { MobileNativeChatSendErrorReporter } from '../composer/delivery/use-mobile-native-chat-send-error'

// Run both hooks in fixed order and starve the inactive lane’s identity so flips preserve cached transcripts.
export function useMobileNativeChatSessionLane({
  client,
  pairedHostClient,
  hostId,
  composerScopeKey,
  structured,
  resolution,
  sourceIdentity,
  hostSupport,
  appendComposerTextRef,
  enabled,
  connState,
  onSendError,
  onQueuedEditNotice,
  onActionResolved,
  itemLink
}: {
  itemLink?: MobileSessionItemLink
  client: RpcClient | null
  pairedHostClient: RpcClient | null
  hostId: string
  composerScopeKey?: string | null
  structured: boolean
  resolution: MobileNativeChatResolution | null
  sourceIdentity: Parameters<typeof useMobileNativeChatSession>[0]['sourceIdentity']
  hostSupport: StructuredAgentSessionHostSupport | null
  // Defer Edit through the composer ref because drafts mount after this lane.
  appendComposerTextRef: { readonly current: (text: string) => boolean }
  enabled: boolean
  connState: ConnectionState
  onQueuedEditNotice?: (message: string) => void
  onSendError: MobileNativeChatSendErrorReporter
  onActionResolved?: () => void
}): {
  structuredSession: ReturnType<typeof useMobileStructuredAgentSession>
  session: ReturnType<typeof useMobileNativeChatSession>
  sessionCommands: ReturnType<typeof useMobileStructuredSessionCommands>
  /** What the chat's controller shows from this lane as is. */
  controllerFields: Pick<
    MobileNativeChatController,
    'nativeChatSessionCommands' | 'nativeChatWorkerApprovals'
  >
} {
  const appendComposerText: MobileComposerWriter = Object.assign(
    useCallback((text: string) => appendComposerTextRef.current(text), [appendComposerTextRef]),
    { captureOrigin: () => appendComposerTextRef.current }
  )
  const agent = resolution?.agent ?? null
  const sessionId = resolution?.sessionId ?? null
  // One read serves both send-side ownership and the composer's `/` menu.
  const sessionCommands = useMobileStructuredSessionCommands({
    client,
    hostId,
    sessionId: structured ? sessionId : null,
    commandsOnRequest: hostSupport?.commandsOnRequest === true,
    enabled: enabled && connState === 'connected'
  })
  const bridgeSession = useMobileNativeChatSession({
    client,
    sourceIdentity,
    agent: structured ? null : agent,
    sessionId: structured ? null : sessionId,
    transcriptPath: structured ? null : (resolution?.transcriptPath ?? null)
  })
  const structuredSession = useMobileStructuredAgentSession({
    itemLink,
    client,
    hostId,
    pairedHostClient,
    sessionId: structured ? sessionId : null,
    sourceIdentity,
    hostSupport,
    appendComposerText,
    composerScopeKey,
    enabled,
    // Holds are connection-scoped; dropping this on transport loss lets the hook
    // reacquire the provider without clearing the cached transcript.
    connected: connState === 'connected',
    agent: structured ? agent : null,
    sessionCommands: sessionCommands.commands,
    onCommandsChanged: sessionCommands.invalidate,
    onSendError,
    onQueuedEditNotice,
    ...(onActionResolved ? { onActionResolved } : {})
  })
  // A coordinator's workers report to its session, on the host that runs them.
  const workerApprovals = useMobileWorkerApprovals({
    client,
    connState,
    // A terminal chat's id is its agent's own, never an Orca session a worker reports to.
    sessionId: structured ? sessionId : null,
    onAnswered: onActionResolved,
    onAnswerError: onSendError
  })
  // Asks from paired servers' agents wait in this agent's Home chat on its host.
  const pairedServerAsks = useMobilePairedServerAsks({
    client,
    connState,
    sessionId: structured ? sessionId : null,
    onAnswerError: onSendError
  })
  return {
    structuredSession,
    session: structured ? structuredSession.session : bridgeSession,
    sessionCommands,
    controllerFields: {
      nativeChatSessionCommands: sessionCommands,
      nativeChatWorkerApprovals: { ...workerApprovals, pairedServerAsks }
    }
  }
}
