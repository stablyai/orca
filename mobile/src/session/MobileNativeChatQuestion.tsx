import { useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { ArrowUp, Check, CircleHelp } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  formatQuestionAnswer,
  formatQuestionAnswerByIndexes,
  formatQuestionAnswerWithOtherByIndexes,
  formatQuestionFreeTextAnswer,
  type MobileChatQuestion
} from './mobile-native-chat-question'

type Props = {
  question: MobileChatQuestion
  onAnswer: (text: string) => Promise<boolean>
}

/** Renders an agent's choice prompt as a tappable card. Single-select answers
 *  on tap; multi-select toggles then Submits; an always-present text entry lets
 *  the user answer freely (the escape hatch) when the heuristic misreads the
 *  options or none apply. */
export function MobileNativeChatQuestion({ question, onAnswer }: Props): React.JSX.Element {
  const [selectedOptionIndexes, setSelectedOptionIndexes] = useState<number[]>([])
  const [freeText, setFreeText] = useState('')
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const allowOther = question.allowOther !== false

  const hasOptions = question.options.length > 0
  const trimmedFreeText = freeText.trim()

  const toggle = (optionIndex: number): void => {
    setSelectedOptionIndexes((prev) =>
      prev.includes(optionIndex)
        ? prev.filter((index) => index !== optionIndex)
        : [...prev, optionIndex]
    )
  }

  const sendAnswer = async (text: string): Promise<boolean> => {
    if (sendingRef.current) {
      return false
    }
    sendingRef.current = true
    setSending(true)
    try {
      return await onAnswer(text)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const answerSingle = async (option: string, optionIndex: number): Promise<void> => {
    const token = question.optionTokens[optionIndex]
    await sendAnswer(token && token.length > 0 ? token : formatQuestionAnswer(question, [option]))
  }

  const submitMulti = async (): Promise<void> => {
    if (selectedOptionIndexes.length === 0) {
      return
    }
    const answer =
      question.freeTextToken && trimmedFreeText.length > 0
        ? formatQuestionAnswerWithOtherByIndexes(question, selectedOptionIndexes, trimmedFreeText)
        : formatQuestionAnswerByIndexes(question, selectedOptionIndexes)
    if (await sendAnswer(answer)) {
      setFreeText('')
    }
  }

  const submitFreeText = async (): Promise<void> => {
    if (trimmedFreeText.length === 0) {
      return
    }
    const answer =
      question.multiSelect && question.freeTextToken && selectedOptionIndexes.length > 0
        ? formatQuestionAnswerWithOtherByIndexes(question, selectedOptionIndexes, trimmedFreeText)
        : formatQuestionFreeTextAnswer(question, trimmedFreeText)
    if (await sendAnswer(answer)) {
      setFreeText('')
    }
  }

  const canSubmitMulti = selectedOptionIndexes.length > 0 && !sending
  const canSendFreeText = allowOther && trimmedFreeText.length > 0 && !sending

  // Stable keys for option rows even if an agent repeats a label.
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
    <View style={styles.card}>
      <View style={styles.header}>
        <CircleHelp size={15} color={colors.accentBlue} strokeWidth={2.2} />
        <Text style={styles.question}>{question.question}</Text>
      </View>

      {hasOptions ? (
        <View style={styles.options}>
          {optionRows.map(({ label, description, key }, optIndex) => {
            const isSelected = selectedOptionIndexes.includes(optIndex)
            return (
              <Pressable
                key={key}
                accessibilityRole={question.multiSelect ? 'checkbox' : 'button'}
                accessibilityState={question.multiSelect ? { checked: isSelected } : undefined}
                style={({ pressed }) => [
                  styles.option,
                  isSelected && styles.optionSelected,
                  pressed && styles.pressed
                ]}
                onPress={() =>
                  question.multiSelect ? toggle(optIndex) : answerSingle(label, optIndex)
                }
              >
                {question.multiSelect ? (
                  <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
                    {isSelected ? <Check size={13} color={colors.bgBase} strokeWidth={3} /> : null}
                  </View>
                ) : null}
                <View style={styles.optionBody}>
                  <Text style={styles.optionText}>{label}</Text>
                  {description ? (
                    <Text style={styles.optionDescription} numberOfLines={2}>
                      {description}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            )
          })}
        </View>
      ) : null}

      {question.multiSelect && hasOptions ? (
        <Pressable
          accessibilityLabel="Submit selected options"
          style={({ pressed }) => [
            styles.submit,
            !canSubmitMulti && styles.submitDisabled,
            pressed && canSubmitMulti && styles.pressed
          ]}
          onPress={submitMulti}
          disabled={!canSubmitMulti}
        >
          <Text style={[styles.submitText, !canSubmitMulti && styles.submitTextDisabled]}>
            Submit{selectedOptionIndexes.length > 0 ? ` (${selectedOptionIndexes.length})` : ''}
          </Text>
        </Pressable>
      ) : null}

      {allowOther ? (
        <View style={styles.freeTextRow}>
          <TextInput
            style={styles.freeInput}
            value={freeText}
            onChangeText={setFreeText}
            placeholder={hasOptions ? 'Or type a reply…' : 'Type your reply…'}
            placeholderTextColor={colors.textMuted}
            selectionColor={colors.accentBlue}
            onSubmitEditing={submitFreeText}
            returnKeyType="send"
            multiline
          />
          <Pressable
            accessibilityLabel="Send reply"
            style={({ pressed }) => [
              styles.freeSend,
              !canSendFreeText && styles.freeSendDisabled,
              pressed && canSendFreeText && styles.pressed
            ]}
            onPress={submitFreeText}
            disabled={!canSendFreeText}
          >
            <ArrowUp
              size={18}
              color={canSendFreeText ? colors.bgBase : colors.textMuted}
              strokeWidth={2.6}
            />
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  question: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    fontWeight: '600',
    lineHeight: typography.bodySize + 7
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
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  optionSelected: {
    borderColor: colors.accentBlue
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
    borderRadius: radii.button,
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
    borderRadius: radii.button,
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
  },
  freeTextRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm
  },
  freeInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm
  },
  freeSend: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.textPrimary
  },
  freeSendDisabled: {
    backgroundColor: colors.bgRaised
  },
  pressed: {
    opacity: 0.7
  }
})
