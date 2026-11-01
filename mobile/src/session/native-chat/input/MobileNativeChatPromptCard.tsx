import { useLayoutEffect, useRef, useState } from 'react'
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent
} from 'react-native'
import { SHEET_CURVE, SHEET_HEIGHT_DURATION_MS } from '../../../components/sheet-motion-values'
import { useReducedMotionEnabled } from '../../../platform/use-reduced-motion'
import { colors, pressedStyle, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { AskAnswerSelection } from '../../../../../src/shared/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'
import type { MobileChatPermission } from './mobile-native-chat-permission'
import { MobileNativeChatQuestion } from './MobileNativeChatQuestion'
import { MobileNativeChatStructuredAsk } from './MobileNativeChatStructuredAsk'
import { mobileChatQuestionKey, type MobileChatQuestion } from './mobile-native-chat-question'
import { MobileNativeChatPromptStrip } from './MobileNativeChatPromptStrip'

// Keep dismissal in the controller across chat/terminal toggles; the shared resolver already chose the terminal card.
export function MobileNativeChatPromptCard({
  ask,
  answering = false,
  askKey,
  onDismissAsk,
  onAnswerAsk,
  requiresTerminal = false,
  onAnswerInTerminal,
  onCancelAsk,
  onCancelPrompt,
  onCollapseAsk,
  onCollapsePrompt,
  collapsedPrompt,
  permission,
  onRespondPermission,
  question,
  onAnswerQuestion
}: {
  ask?: AskPrompt | null
  // The keyboard is up for this card's reply, so it may take the whole conversation area.
  answering?: boolean
  askKey?: string | null
  onDismissAsk?: () => void
  onAnswerAsk?: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  requiresTerminal?: boolean
  onAnswerInTerminal?: () => void
  onCancelAsk?: () => Promise<boolean>
  onCancelPrompt?: (prompt?: NonNullable<MobileChatPermission['prompt']>) => Promise<boolean>
  onCollapseAsk?: () => void
  onCollapsePrompt?: () => void
  collapsedPrompt?: { title: string; expand: () => void } | null
  permission?: MobileChatPermission | null
  onRespondPermission?: (send: string) => Promise<boolean>
  question?: MobileChatQuestion | null
  onAnswerQuestion?: (text: string, prompt?: MobileChatQuestion['prompt']) => Promise<boolean>
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const card =
    ask && requiresTerminal ? (
      <View style={styles.terminalCard}>
        <Text style={styles.explanation}>
          {t('chat.promptCard.terminalExplanation', 'Answer this OMP question in the terminal.')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('chat.promptCard.answerInTerminal', 'Answer in terminal')}
          accessibilityState={{ disabled: !onAnswerInTerminal }}
          disabled={!onAnswerInTerminal}
          onPress={onAnswerInTerminal}
          style={({ pressed }) => [styles.terminalButton, pressed && pressedStyle]}
        >
          <Text style={styles.terminalButtonText}>
            {t('chat.promptCard.answerInTerminal', 'Answer in terminal')}
          </Text>
        </Pressable>
      </View>
    ) : ask ? (
      <MobileNativeChatAsk
        key={askKey ?? 'ask'}
        prompt={ask}
        onAnswer={async (selections) => {
          const accepted = (await onAnswerAsk?.(ask, selections)) ?? false
          if (accepted && !ask.replyAsMessage) {
            onDismissAsk?.()
          }
          return accepted
        }}
        onCancel={async () => {
          // The agent is not waiting on this card, and Escape would interrupt its turn.
          const accepted = ask.replyAsMessage ? true : ((await onCancelAsk?.()) ?? false)
          if (accepted) {
            onDismissAsk?.()
          }
          return accepted
        }}
        onCollapse={onCollapseAsk}
      />
    ) : permission ? (
      <MobileNativeChatPermission
        key={JSON.stringify(permission)}
        permission={permission}
        onRespond={async (send) => (await onRespondPermission?.(send)) ?? false}
        onCancel={onCancelPrompt}
        onCollapse={onCollapsePrompt}
      />
    ) : question?.questions ? (
      <MobileNativeChatStructuredAsk
        key={mobileChatQuestionKey(question)}
        questions={question.questions}
        onAnswer={async (answers) => (await onAnswerQuestion?.(answers, question.prompt)) ?? false}
        onCancel={onCancelPrompt && (() => onCancelPrompt(question.prompt))}
      />
    ) : question ? (
      <MobileNativeChatQuestion
        key={mobileChatQuestionKey(question)}
        question={question}
        onAnswer={async (text) => (await onAnswerQuestion?.(text)) ?? false}
        onCancel={onCancelPrompt}
      />
    ) : null
  const arrival = usePromptCardArrival(card !== null)
  // Hide without remounting so a collapsed prompt keeps partial selections.
  return (
    <>
      <View
        style={
          collapsedPrompt
            ? styles.collapsed
            : [styles.shown, answering && styles.answering, arrival.arriving && styles.arriving]
        }
        onLayout={arrival.onLayout}
      >
        <Animated.View style={[styles.arrivalLayer, arrival.style]}>{card}</Animated.View>
      </View>
      {collapsedPrompt ? (
        <MobileNativeChatPromptStrip
          title={collapsedPrompt.title}
          onExpand={collapsedPrompt.expand}
        />
      ) : null}
    </>
  )
}

const ARRIVAL_EASING = Easing.bezier(...SHEET_CURVE)
const REDUCED_ARRIVAL_MS = 200

// A card that appears rises out of the composer's edge, so the ask reads as coming from below.
function usePromptCardArrival(hasCard: boolean) {
  const reducedMotion = useReducedMotionEnabled() === true
  const progress = useRef(new Animated.Value(1)).current
  // The card's own height, read on the layout after it appears; null while that read is pending.
  const [travel, setTravel] = useState<number | null>(0)
  useLayoutEffect(() => {
    if (!hasCard) {
      return
    }
    progress.setValue(0)
    setTravel(null)
    return () => progress.stopAnimation()
  }, [hasCard, progress])
  const onLayout = (event: LayoutChangeEvent) => {
    if (travel !== null) {
      return
    }
    setTravel(event.nativeEvent.layout.height)
    Animated.timing(progress, {
      toValue: 1,
      duration: reducedMotion ? REDUCED_ARRIVAL_MS : SHEET_HEIGHT_DURATION_MS,
      easing: ARRIVAL_EASING,
      useNativeDriver: Platform.OS !== 'web'
    }).start(({ finished }) => {
      if (finished) {
        setTravel(0)
      }
    })
  }
  const style =
    travel === null
      ? { opacity: 0 }
      : reducedMotion
        ? { opacity: progress }
        : {
            transform: [
              { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] }) }
            ]
          }
  return { arriving: travel !== 0, onLayout, style }
}

const styles = themedStyleSheet(() => ({
  collapsed: { display: 'none' },
  // Clips the rising card to its own slot so it never draws over the composer.
  arriving: { overflow: 'hidden' },
  // Passes the slot's height cap through to the card, so a tall card still scrolls inside it.
  arrivalLayer: { flexShrink: 1, minHeight: 0 },
  // Leave the conversation visible above the question, as desktop caps its card.
  shown: { flexShrink: 1, minHeight: 0, maxHeight: '60%' },
  answering: { maxHeight: '100%' },
  terminalCard: {
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    padding: spacing.md,
    gap: spacing.sm
  },
  explanation: { color: colors.textPrimary, fontSize: typography.bodySize },
  terminalButton: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: colors.surfaceBright,
    borderRadius: radii.control,
    paddingHorizontal: spacing.md
  },
  terminalButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
}))
