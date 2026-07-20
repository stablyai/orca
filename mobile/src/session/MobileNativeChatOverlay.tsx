import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Volume2, VolumeX } from 'lucide-react-native'
import { MobileNativeChatView, type MobileNativeChatInputLockReason } from './MobileNativeChatView'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'
import { nativeChatMessageText } from './mobile-native-chat-message-text'
import { useMeshSpeak } from '../voice/use-mesh-speak'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

type Props = {
  controller: MobileNativeChatController
  onAttachImage: () => void
  isAttaching: boolean
  onMicPress: () => void
  micActive: boolean
  dictationMode: 'toggle' | 'hold'
  onMicPressIn: () => void
  onMicPressOut: () => void
  inputLockReason: MobileNativeChatInputLockReason | null
  keyboardInset: number
}

/** Keeps the terminal mounted underneath chat so its PTY subscription survives
 *  view toggles while the native surface owns the visible composer. */
export function MobileNativeChatOverlay({
  controller,
  onAttachImage,
  isAttaching,
  onMicPress,
  micActive,
  dictationMode,
  onMicPressIn,
  onMicPressOut,
  inputLockReason,
  keyboardInset
}: Props): React.JSX.Element | null {
  const session = controller.nativeChatSession
  const { speak } = useMeshSpeak()
  // A2a: per-session speak-back. Toggle auto-speaks each completed agent reply;
  // the per-message speaker button (onSpeak) plays any reply on demand. TTS is
  // the mesh Kokoro route — the delta over Orca's STT-only native voice.
  const [speakReplies, setSpeakReplies] = useState(false)
  const wasWorkingRef = useRef(false)
  const lastSpokenIdRef = useRef<string | null>(null)

  const working = controller.nativeChatAgentWorking
  const messages = session.messages
  useEffect(() => {
    // Speak when the agent transitions from working -> done and the latest
    // message is its reply. Dedupe by id so re-renders don't repeat it.
    if (wasWorkingRef.current && !working && speakReplies) {
      const last = messages[messages.length - 1]
      if (last && last.role !== 'user' && last.id !== lastSpokenIdRef.current) {
        const text = nativeChatMessageText(last.blocks)
        if (text) {
          lastSpokenIdRef.current = last.id
          speak(text)
        }
      }
    }
    wasWorkingRef.current = working
  }, [working, speakReplies, messages, speak])

  if (!controller.showNativeChat) {
    return null
  }
  return (
    <View style={styles.overlay}>
      <MobileNativeChatView
        messages={session.messages}
        status={session.status}
        error={session.error}
        agent={controller.nativeChatAgent}
        agentWorking={controller.nativeChatAgentWorking}
        streamingText={controller.nativeChatStreamingText}
        onStop={controller.handleNativeChatStop}
        ask={controller.nativeChatAsk}
        onAnswerAsk={controller.handleNativeChatAnswerAsk}
        onCancelAsk={controller.handleNativeChatCancelAsk}
        question={controller.nativeChatQuestion}
        onAnswerQuestion={controller.handleNativeChatSend}
        permission={controller.nativeChatPermission}
        onRespondPermission={controller.handleNativeChatRespondPermission}
        onOpenFile={controller.handleNativeChatOpenFile}
        hasMore={session.hasMore}
        loadingEarlier={session.loadingEarlier}
        onLoadEarlier={session.loadEarlier}
        onSend={controller.handleNativeChatSend}
        pending={controller.chatPending}
        composerText={controller.chatComposerText}
        onComposerTextChange={controller.setChatComposerText}
        onAttachImage={onAttachImage}
        isAttaching={isAttaching}
        onMicPress={onMicPress}
        micActive={micActive}
        dictationMode={dictationMode}
        onMicPressIn={onMicPressIn}
        onMicPressOut={onMicPressOut}
        inputLockReason={inputLockReason}
        filePaths={controller.nativeChatFilePaths}
        onNeedFiles={controller.loadNativeChatFiles}
        onSpeak={speak}
        keyboardInset={keyboardInset}
      />
      <Pressable
        style={({ pressed }) => [
          styles.speakToggle,
          speakReplies && styles.speakToggleOn,
          pressed && styles.speakTogglePressed
        ]}
        onPress={() => setSpeakReplies((v) => !v)}
        hitSlop={8}
        accessibilityLabel={speakReplies ? 'Turn off speak replies' : 'Turn on speak replies'}
      >
        {speakReplies ? (
          <Volume2 size={14} color={colors.accentBlue} strokeWidth={2} />
        ) : (
          <VolumeX size={14} color={colors.textMuted} strokeWidth={2} />
        )}
        <Text style={[styles.speakToggleText, speakReplies && styles.speakToggleTextOn]}>
          Speak replies
        </Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: StyleSheet.absoluteFillObject,
  speakToggle: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  speakToggleOn: {
    borderColor: colors.accentBlue
  },
  speakTogglePressed: {
    backgroundColor: colors.bgRaised
  },
  speakToggleText: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  speakToggleTextOn: {
    color: colors.accentBlue
  }
})
