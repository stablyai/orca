import { useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { useRouteHandoff } from '../navigation/route-handoff'
import { HOST_GROUP_ROUTE } from '../navigation/host-stack-navigation'
import { useMobileScreenDictation } from '../session/use-mobile-screen-dictation'
import { useMobileDictationLive } from '../dictation/use-mobile-dictation-live'
import type { MobileNativeChatMicProps } from '../session/native-chat/composer/dictation/MobileNativeChatComposerMic'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useBackClaim } from '../navigation/use-back-claim'
import { MobileDictationLiveContext } from '../dictation/mobile-dictation-live-context'
import { MobileNativeChatDictationPreviewContext } from '../session/native-chat/composer/dictation/mobile-native-chat-dictation-preview-context'
import { MobileDictationSetupSheet } from '../dictation/setup/MobileDictationSetupSheet'
import { focusMobileNativeChatTextDestination } from '../session/native-chat/composer/drafts/mobile-native-chat-draft-inputs'
import { renderAnimatedToast, useTransientToast } from '../components/feedback/TransientToast'
import { View } from 'react-native'

const noTerminal = () => Promise.resolve(false)

/** The room composer's mic: the page's one dictation, as an agent's chat drives it, into the room's draft. */
export function useMobileBotGroupDictation({
  client,
  connected,
  hostId,
  groupId,
  threadId,
  title,
  draft
}: {
  client: RpcClient
  connected: boolean
  hostId: string
  groupId: string
  threadId: string | undefined
  title: string
  draft: { key: string; edit: Dispatch<SetStateAction<string>> }
}) {
  const router = useRouteHandoff()
  // The chat's passing toast, not the room's send-error banner; the dictation host speaks it.
  const toast = useTransientToast()
  const [showDictationSetup, setShowDictationSetup] = useState(false)
  const [dictationMode, setDictationMode] = useState<string | undefined>('toggle')
  const [dictationEnabled, setDictationEnabled] = useState(true)
  // A room has no terminal: its composer is always shown and takes the words.
  const activeHandleRef = useRef<string | null>(null)
  const dictationRouteContextRef = useRef<{ readonly handle: string } | null>(null)
  const showNativeChatRef = useRef(true)
  const screen = useMobileScreenDictation(
    {
      hostId,
      worktreeId: '',
      client,
      connState: connected ? 'connected' : 'disconnected',
      activeHandle: null,
      activeHandleRef,
      setShowDictationSetup,
      dictationRouteContextRef,
      flushPendingLiveInputBeforeExternalSend: noTerminal,
      canSend: false,
      showToast: toast.showToast,
      router,
      dictationMode,
      setDictationMode,
      setDictationEnabled
    },
    {
      showNativeChat: true,
      showNativeChatRef,
      chatComposerScopeKey: draft.key,
      setChatComposerText: draft.edit
    },
    noTerminal,
    {
      key: JSON.stringify(['group', hostId, groupId]),
      name: HOST_GROUP_ROUTE,
      title,
      paneKey: undefined,
      // The room it started in, so the pill reopens the thread whose draft gets the words.
      href: `/h/${encodeURIComponent(hostId)}/group/${encodeURIComponent(groupId)}${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ''}`
    }
  )
  const { dictation, dictationLeaveHold: leaveHold } = screen
  // Leaving the room's page ends its dictation, so the first Back stops it and inserts what was said.
  useBackClaim(leaveHold.holdsLeave ? leaveHold.hold : null)
  const live = useMobileDictationLive(dictation, screen.cancelDictation, hostId)
  // The mic makes this room's draft the target before it starts, as focusing its field does; another
  // room's field may still hold the page's focus.
  const here = (start: () => void) => () => {
    focusMobileNativeChatTextDestination(draft.key)
    start()
  }
  const mic: MobileNativeChatMicProps = {
    onMicPress: dictationEnabled ? here(screen.handleDictationToggle) : undefined,
    micActive: dictation.isStarting || dictation.isRecording,
    micStarting: dictation.isStarting,
    micProcessing: dictation.isProcessing,
    dictationMode,
    onMicPressIn: here(screen.handleDictationPressIn),
    onMicPressOut: screen.handleDictationPressOut
  }
  return {
    mic,
    live,
    preview: screen.chatDictationPreview,
    back: () => {
      if (!leaveHold.hold()) {
        router.back()
      }
    },
    setup: { visible: showDictationSetup, close: screen.closeDictationSetup },
    toast: toast.message
  }
}

/** The room composer's dictation controls and words heard so far, its toast just above the composer,
 *  and the setup sheet its mic opens. */
export function MobileBotGroupDictationScope({
  dictation,
  client,
  children
}: {
  dictation: ReturnType<typeof useMobileBotGroupDictation>
  client: RpcClient
  children: ReactNode
}) {
  return (
    <MobileDictationLiveContext.Provider value={dictation.live}>
      <MobileNativeChatDictationPreviewContext.Provider value={dictation.preview}>
        <View>{renderAnimatedToast(dictation.toast, null)}</View>
        {children}
      </MobileNativeChatDictationPreviewContext.Provider>
      <MobileDictationSetupSheet
        visible={dictation.setup.visible}
        client={client}
        onClose={dictation.setup.close}
        onReady={dictation.setup.close}
      />
    </MobileDictationLiveContext.Provider>
  )
}
