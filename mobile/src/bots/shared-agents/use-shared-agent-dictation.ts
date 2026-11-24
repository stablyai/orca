// The shared agent's chat's mic: the session screen's dictation on a page with one chat, transcribed by
// the paired computer (or the phone itself) and inserted into the chat's composer.
import { useRef, useState } from 'react'
import type { MobileSessionDictationScope } from '../../session/mobile-session-dictation-scope'
import { useMobileSessionDictation } from '../../session/use-mobile-session-dictation'
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
  tab: NonNullable<MobileSessionDictationScope['activeSessionTab']>
  connState: ConnectionState
  controller: MobileNativeChatController
  showToast: (message: string) => void
  href: string
}) {
  const router = useRouteHandoff()
  const [showSetup, setShowSetup] = useState(false)
  const [dictationMode, setDictationMode] = useState<string | undefined>('toggle')
  const [enabled, setEnabled] = useState(true)
  const routeContextRef: MobileSessionDictationScope['dictationRouteContextRef'] = useRef(null)
  const terminalRef = useRef<string | null>(null)
  const scope: MobileSessionDictationScope = {
    hostId: args.hostId,
    worktreeId: args.worktreeId,
    client: args.pairedClient,
    connState: args.connState,
    activeHandle: null,
    activeHandleRef: terminalRef,
    activeSessionTab: args.tab,
    setShowDictationSetup: setShowSetup,
    dictationRouteContextRef: routeContextRef,
    flushPendingLiveInputBeforeExternalSend: nothingPending,
    canSend: false,
    showToast: args.showToast,
    router,
    dictationMode,
    setDictationMode,
    setDictationEnabled: setEnabled,
    dictationHref: args.href
  }
  const dictation = useMobileSessionDictation(scope, args.controller, noTerminal)
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
