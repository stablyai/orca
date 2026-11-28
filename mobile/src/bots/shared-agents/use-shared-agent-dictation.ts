// The shared agent's chat's mic: the screen dictation on a page with one chat, transcribed by
// the paired computer (or the phone itself) and inserted into the chat's composer.
import { useRef, useState } from 'react'
import type { MobileScreenDictationScope } from '../../session/mobile-screen-dictation-scope'
import type { MobileSessionFeedbackCapabilitiesModel } from '../../session/use-mobile-session-feedback-capabilities'
import { useMobileScreenDictation } from '../../session/use-mobile-screen-dictation'
import { HOST_SESSION_ROUTE } from '../../navigation/host-stack-navigation'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { sessionTabPaneKey } from '../../../../src/shared/remote-runtime/session-graph/session-tab-pane-key'
import type { MobileNativeChatController } from '../../session/native-chat/mobile-native-chat-controller-contract'
import { useRouteHandoff } from '../../navigation/route-handoff'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

const noTerminal = async () => false
const nothingPending = async () => true

export function useSharedAgentDictation(args: {
  /** The paired computer, which hears the dictation; the agent's host isn't asked. */
  pairedClient: RpcClient | null
  hostId: string
  worktreeId: string
  tab: NonNullable<MobileSessionFeedbackCapabilitiesModel['activeSessionTab']>
  connState: ConnectionState
  controller: MobileNativeChatController
  showToast: (message: string) => void
  href: string
}) {
  const router = useRouteHandoff()
  const [showSetup, setShowSetup] = useState(false)
  const [dictationMode, setDictationMode] = useState<string | undefined>('toggle')
  const [enabled, setEnabled] = useState(true)
  const executionHost = useWorkspaceExecutionHost()
  const routeContextRef: MobileScreenDictationScope['dictationRouteContextRef'] = useRef(null)
  const terminalRef = useRef<string | null>(null)
  const scope: MobileScreenDictationScope = {
    hostId: args.hostId,
    worktreeId: args.worktreeId,
    client: args.pairedClient,
    connState: args.connState,
    activeHandle: null,
    activeHandleRef: terminalRef,
    setShowDictationSetup: setShowSetup,
    dictationRouteContextRef: routeContextRef,
    flushPendingLiveInputBeforeExternalSend: nothingPending,
    canSend: false,
    showToast: args.showToast,
    router,
    dictationMode,
    setDictationMode,
    setDictationEnabled: setEnabled
  }
  const dictation = useMobileScreenDictation(scope, args.controller, noTerminal, {
    key: JSON.stringify([args.hostId, executionHost ?? null, args.worktreeId]),
    name: HOST_SESSION_ROUTE,
    title: args.tab.title ?? '',
    paneKey: sessionTabPaneKey(args.tab),
    href: args.href
  })
  const live = dictation.dictation
  return {
    mic: {
      onMicPress: enabled ? dictation.handleDictationToggle : undefined,
      micActive: live.isStarting || live.isRecording,
      micStarting: live.isStarting,
      micProcessing: live.isProcessing,
      dictationMode,
      onMicPressIn: dictation.handleDictationPressIn,
      onMicPressOut: dictation.handleDictationPressOut
    },
    setup: { visible: showSetup, close: dictation.closeDictationSetup }
  }
}
