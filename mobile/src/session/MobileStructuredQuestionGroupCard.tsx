import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Check, ChevronLeft, ChevronRight, CircleHelp } from 'lucide-react-native'
import type { AgentJournalQuestion } from '../../../src/shared/agent-session-journal-types'
import {
  encodeAgentSessionQuestionAnswers,
  type AgentSessionQuestionAnswer
} from '../../../src/shared/agent-session-question-answer'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export function MobileStructuredQuestionGroupCard(props: {
  questions: readonly AgentJournalQuestion[]
  onAnswer: (encoded: string) => Promise<boolean>
}): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [selections, setSelections] = useState<number[][]>(() => props.questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() => props.questions.map(() => ''))
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const question = props.questions[index]!
  const isLast = index === props.questions.length - 1

  const answerAt = (questionIndex: number): AgentSessionQuestionAnswer => {
    const current = props.questions[questionIndex]!
    const other = otherText[questionIndex]?.trim()
    const optionIds = (selections[questionIndex] ?? []).flatMap((optionIndex) => {
      const optionId = current.options[optionIndex]?.id
      return optionId ? [optionId] : []
    })
    return {
      questionId: current.id,
      optionIds: current.multiSelect || !other ? optionIds : [],
      ...(other ? { other } : {})
    }
  }

  const isAnswered = (questionIndex: number): boolean => {
    const answer = answerAt(questionIndex)
    return answer.optionIds.length > 0 || Boolean(answer.other)
  }

  const toggleOption = (optionIndex: number): void => {
    setSelections((current) => {
      const next = current.map((selected) => [...selected])
      const selected = next[index] ?? []
      next[index] = question.multiSelect
        ? selected.includes(optionIndex)
          ? selected.filter((value) => value !== optionIndex)
          : [...selected, optionIndex].sort((left, right) => left - right)
        : [optionIndex]
      return next
    })
    if (!question.multiSelect) {
      setOtherText((current) => current.map((text, i) => (i === index ? '' : text)))
    }
  }

  const setOther = (value: string): void => {
    setOtherText((current) => current.map((text, i) => (i === index ? value : text)))
    if (!question.multiSelect && value.trim()) {
      setSelections((current) => current.map((selected, i) => (i === index ? [] : selected)))
    }
  }

  const advanceOrSubmit = async (): Promise<void> => {
    if (!isAnswered(index) || sendingRef.current) {
      return
    }
    if (!isLast) {
      setIndex((current) => current + 1)
      return
    }
    const answers = props.questions.map((_, questionIndex) => answerAt(questionIndex))
    if (answers.some((answer) => answer.optionIds.length === 0 && !answer.other)) {
      return
    }
    sendingRef.current = true
    setSending(true)
    try {
      await props.onAnswer(encodeAgentSessionQuestionAnswers(answers))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <CircleHelp size={15} color={colors.accentBlue} strokeWidth={2.2} />
        <View style={styles.headerText}>
          <Text style={styles.stepLabel}>{question.header ?? `Question ${index + 1}`}</Text>
          <Text style={styles.question}>{question.question}</Text>
        </View>
      </View>

      <View style={styles.options}>
        {question.options.map((option, optionIndex) => {
          const selected = (selections[index] ?? []).includes(optionIndex)
          return (
            <Pressable
              key={`${optionIndex}:${option.id}`}
              accessibilityRole={question.multiSelect ? 'checkbox' : 'button'}
              accessibilityState={question.multiSelect ? { checked: selected } : undefined}
              style={({ pressed }) => [
                styles.option,
                selected && styles.optionSelected,
                pressed && styles.pressed
              ]}
              onPress={() => toggleOption(optionIndex)}
              disabled={sending}
            >
              <View style={[styles.optionBadge, selected && styles.optionBadgeSelected]}>
                {selected ? (
                  <Check size={13} color={colors.onAccent} strokeWidth={3} />
                ) : (
                  <Text style={styles.optionNumber}>{optionIndex + 1}</Text>
                )}
              </View>
              <View style={styles.optionTextGroup}>
                <Text style={styles.optionText}>{option.label}</Text>
                {option.description ? (
                  <Text style={styles.optionDescription}>{option.description}</Text>
                ) : null}
              </View>
            </Pressable>
          )
        })}
      </View>

      {question.freeTextQuestionId ? (
        <TextInput
          value={otherText[index]}
          onChangeText={setOther}
          placeholder="Or type another answer…"
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.accentBlue}
          style={styles.freeInput}
          multiline
          editable={!sending}
        />
      ) : null}

      <View style={styles.footer}>
        <Pressable
          accessibilityLabel="Previous question"
          style={({ pressed }) => [
            styles.navButton,
            index === 0 && styles.disabled,
            pressed && styles.pressed
          ]}
          onPress={() => setIndex((current) => Math.max(0, current - 1))}
          disabled={index === 0 || sending}
        >
          <ChevronLeft size={16} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.progress}>
          {index + 1} / {props.questions.length}
        </Text>
        <Pressable
          accessibilityLabel={isLast ? 'Submit answers' : 'Next question'}
          style={({ pressed }) => [
            styles.actionButton,
            !isAnswered(index) && styles.disabled,
            pressed && styles.pressed
          ]}
          onPress={() => void advanceOrSubmit()}
          disabled={!isAnswered(index) || sending}
        >
          <Text style={styles.actionText}>{sending ? 'Sending…' : isLast ? 'Submit' : 'Next'}</Text>
          {!isLast && !sending ? <ChevronRight size={15} color={colors.onAccent} /> : null}
        </Pressable>
      </View>
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
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  headerText: { flex: 1, gap: spacing.xs },
  stepLabel: { color: colors.textMuted, fontSize: typography.metaSize, fontWeight: '600' },
  question: {
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    fontWeight: '600',
    lineHeight: typography.bodySize + 7
  },
  options: { gap: spacing.xs },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.button,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  optionSelected: { borderColor: colors.accentBlue },
  optionBadge: {
    width: 20,
    height: 20,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel,
    alignItems: 'center',
    justifyContent: 'center'
  },
  optionBadgeSelected: { backgroundColor: colors.accentBlue },
  optionNumber: { color: colors.textMuted, fontSize: typography.metaSize },
  optionTextGroup: { flex: 1 },
  optionText: { color: colors.textPrimary, fontSize: typography.bodySize + 1 },
  optionDescription: { color: colors.textMuted, fontSize: typography.metaSize },
  freeInput: {
    minHeight: 44,
    maxHeight: 120,
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  navButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  progress: { flex: 1, color: colors.textMuted, fontSize: typography.metaSize },
  actionButton: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button,
    backgroundColor: colors.accentBlue
  },
  actionText: { color: colors.onAccent, fontSize: typography.bodySize, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 }
})
