import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Check, CircleHelp } from 'lucide-react-native'
import { MobileNativeChatCardHeaderAction } from './MobileNativeChatCardHeaderAction'
import { MobileNativeChatQuestionText } from '../../transcript/message-content/MobileNativeChatQuestionText'
import {
  colors,
  concentricRadius,
  pressedStyle,
  radii,
  spacing,
  typography
} from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MessageBox } from '../../../../components/composer-input/MessageBox'
import { MobilePendingButton } from '../../../../components/controls/MobilePendingButton'
import { useMobilePendingControl } from '../../../../components/controls/use-mobile-pending-control'
import { useMobileNativeChatReplyScroll } from './use-mobile-native-chat-reply-scroll'
import {
  formatQuestionAnswerByIndexes,
  formatQuestionAnswerWithOtherByIndexes,
  formatQuestionFreeTextAnswer,
  type MobileChatQuestion
} from './mobile-native-chat-question'

type Props = {
  question: MobileChatQuestion
  onAnswer: (text: string) => Promise<boolean>
  onCancel?: (prompt?: NonNullable<MobileChatQuestion['prompt']>) => Promise<boolean>
  // Collapse writes nothing to the agent.
  onCollapse?: () => void
}

// Keep free text available when heuristic options are incomplete or misread.
export function MobileNativeChatQuestion({
  question,
  onAnswer,
  onCancel,
  onCollapse
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { scrollRef, inputRef, revealReply, onViewportLayout } = useMobileNativeChatReplyScroll()
  const [selectedOptionIndexes, setSelectedOptionIndexes] = useState<number[]>([])
  const [freeText, setFreeText] = useState(() => question.freeTextInput?.initialValue ?? '')
  // A single choice sends as `option:<index>`; Submit, the typed reply and the header's cancel by name.
  const { pending, run } = useMobilePendingControl<string>()
  const sending = pending !== null
  const allowOther = question.allowOther !== false

  const hasOptions = question.options.length > 0
  const answerText = question.freeTextInput?.allowEmpty ? freeText : freeText.trim()

  const toggle = (optionIndex: number): void => {
    setSelectedOptionIndexes((prev) =>
      prev.includes(optionIndex)
        ? prev.filter((index) => index !== optionIndex)
        : [...prev, optionIndex]
    )
  }

  const sendAnswer = (control: string, text: string): Promise<boolean> =>
    run(control, () => onAnswer(text))

  const answerSingle = async (optionIndex: number): Promise<void> => {
    const token = question.optionTokens[optionIndex]
    await sendAnswer(
      `option:${optionIndex}`,
      token && token.length > 0 ? token : formatQuestionAnswerByIndexes(question, [optionIndex])
    )
  }

  const submitMulti = async (): Promise<void> => {
    if (selectedOptionIndexes.length === 0) {
      return
    }
    const answer =
      question.freeTextToken && answerText.length > 0
        ? formatQuestionAnswerWithOtherByIndexes(question, selectedOptionIndexes, answerText)
        : formatQuestionAnswerByIndexes(question, selectedOptionIndexes)
    if (await sendAnswer('submit', answer)) {
      setFreeText('')
    }
  }

  const submitFreeText = async (): Promise<void> => {
    if (!allowOther || (answerText.length === 0 && !question.freeTextInput?.allowEmpty)) {
      return
    }
    const answer =
      question.multiSelect && question.freeTextToken && selectedOptionIndexes.length > 0
        ? formatQuestionAnswerWithOtherByIndexes(question, selectedOptionIndexes, answerText)
        : formatQuestionFreeTextAnswer(question, answerText)
    if (await sendAnswer('reply', answer)) {
      setFreeText('')
    }
  }

  const canSubmitMulti = selectedOptionIndexes.length > 0 && !sending
  const canSendFreeText =
    allowOther && (answerText.length > 0 || question.freeTextInput?.allowEmpty === true) && !sending

  // Include occurrence in keys because an agent may repeat option labels.
  const optionRows = useMemo(
    () =>
      question.options.map((label, index) => ({
        label,
        description: question.optionDescriptions?.[index],
        key: `${index}:${label}`
      })),
    [question.optionDescriptions, question.options]
  )

  return (
    <ScrollView
      ref={scrollRef}
      onLayout={onViewportLayout}
      style={styles.card}
      contentContainerStyle={styles.cardContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <CircleHelp size={15} color={colors.accentBlue} strokeWidth={2.2} />
        <MobileNativeChatQuestionText title content={question.question} style={styles.question} />
        <MobileNativeChatCardHeaderAction
          prompt={question.prompt}
          onCancel={onCancel && (() => run('cancel', () => onCancel(question.prompt)))}
          onCollapse={onCollapse}
          disabled={sending}
          cancelPending={pending === 'cancel'}
        />
      </View>

      {hasOptions ? (
        <View style={styles.options}>
          {optionRows.map(({ label, description, key }, optIndex) => {
            const isSelected = selectedOptionIndexes.includes(optIndex)
            const body = (
              <View style={styles.optionBody}>
                <Text style={styles.optionText}>{label}</Text>
                {description ? (
                  <Text style={styles.optionDescription} numberOfLines={2}>
                    {description}
                  </Text>
                ) : null}
              </View>
            )
            // A multi-select row only toggles; a single choice is the answer and sends on tap.
            return question.multiSelect ? (
              <Pressable
                key={key}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSelected, disabled: sending }}
                style={({ pressed }) => [
                  styles.option,
                  isSelected && styles.optionSelected,
                  pressed && pressedStyle
                ]}
                disabled={sending}
                onPress={() => toggle(optIndex)}
              >
                <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
                  {isSelected ? <Check size={13} color={colors.bgBase} strokeWidth={3} /> : null}
                </View>
                {body}
              </Pressable>
            ) : (
              <MobilePendingButton
                key={key}
                label={label}
                accessibilityHint={description || undefined}
                // The choice being sent reads as chosen, as on the Ask card.
                style={[styles.option, pending === `option:${optIndex}` && styles.optionSelected]}
                contentStyle={styles.optionContent}
                spinnerColor={colors.textPrimary}
                pending={pending === `option:${optIndex}`}
                disabled={sending}
                onPress={() => void answerSingle(optIndex)}
              >
                {body}
              </MobilePendingButton>
            )
          })}
        </View>
      ) : null}

      {question.multiSelect && hasOptions ? (
        <MobilePendingButton
          label={
            selectedOptionIndexes.length > 0
              ? t('chat.question.submitCount', 'Submit ({{count}})', {
                  count: selectedOptionIndexes.length
                })
              : t('chat.question.submit', 'Submit')
          }
          accessibilityLabel={t('chat.question.submitSelectedOptions', 'Submit selected options')}
          style={styles.submit}
          labelStyle={[styles.submitText, !canSubmitMulti && styles.submitTextDisabled]}
          // Nothing picked is the button's own empty look, as on the composer's Send.
          disabledStyle={styles.submitDisabled}
          spinnerColor={colors.onMergeGreen}
          pending={pending === 'submit'}
          disabled={!canSubmitMulti}
          onPress={() => void submitMulti()}
        />
      ) : null}

      {allowOther ? (
        <MessageBox
          inputRef={inputRef}
          onFocus={revealReply}
          value={freeText}
          onChangeText={setFreeText}
          placeholder={
            question.freeTextInput?.placeholder ??
            (hasOptions
              ? t('chat.question.otherReplyPlaceholder', 'Or type a reply…')
              : t('chat.question.replyPlaceholder', 'Type your reply…'))
          }
          onSubmitEditing={submitFreeText}
          returnKeyType="send"
          // A declared input (Pi's `input`) is one line unless it asks for more, as on desktop.
          multiline={question.freeTextInput ? question.freeTextInput.multiline === true : true}
          onSend={submitFreeText}
          canSend={canSendFreeText}
          sending={pending === 'reply'}
          sendAccessibilityLabel={t('chat.question.sendReply', 'Send reply')}
        />
      ) : null}
    </ScrollView>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  cardContent: {
    padding: spacing.md,
    gap: spacing.sm
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  question: {
    flex: 1
  },
  options: {
    gap: spacing.xs
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: concentricRadius(radii.surface, spacing.xs),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  optionSelected: {
    borderColor: colors.accentBlue
  },
  optionContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center'
  },
  optionBody: {
    flex: 1,
    gap: 2
  },
  optionText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1
  },
  optionDescription: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: typography.metaSize + 5
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: radii.mark,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  checkboxOn: {
    backgroundColor: colors.accentBlue,
    borderColor: colors.accentBlue
  },
  submit: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.control,
    backgroundColor: colors.accentBlue
  },
  submitDisabled: {
    backgroundColor: colors.bgRaised
  },
  submitText: {
    color: colors.onMergeGreen,
    fontSize: typography.bodySize + 1,
    fontWeight: '600'
  },
  submitTextDisabled: {
    color: colors.textMuted
  }
}))
