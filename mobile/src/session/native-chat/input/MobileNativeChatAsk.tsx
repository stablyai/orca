import { useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Check } from 'lucide-react-native'
import type { AskAnswerSelection } from '../../../../../src/shared/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../src/shared/native-chat-ask-types'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { TEXT_INPUT_FONT_SIZE } from '../../../platform/text-input-font-size'
import { MobileNativeChatCardHeaderAction } from '../../MobileNativeChatCardHeaderAction'
import { useMobileNativeChatAskAutoAdvance } from './use-mobile-native-chat-ask-auto-advance'

type Props = {
  prompt: AskPrompt
  // Use option indices so Claude’s selector can navigate without pasting labels.
  onAnswer: (selections: AskAnswerSelection[]) => Promise<boolean>
  onCancel?: () => Promise<boolean>
  // Collapse writes nothing to the agent.
  onCollapse?: () => void
}

// Sentinel index for the free-text "Other…" row (never a real option index).
const OTHER = -1

export function MobileNativeChatAsk({
  prompt,
  onAnswer,
  onCancel,
  onCollapse
}: Props): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [selections, setSelections] = useState<number[][]>(() => prompt.questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() => prompt.questions.map(() => ''))
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const autoAdvance = useMobileNativeChatAskAutoAdvance()

  // Delay single-select advance to show the choice; Other still needs text.
  const toggle = (qi: number, optIndex: number, multi: boolean): void => {
    // Block same-frame taps before disabled state renders.
    if (submittingRef.current) {
      return
    }
    const cur = selections[qi] ?? []
    const picked = !cur.includes(optIndex)
    const chosen = !picked
      ? cur.filter((i) => i !== optIndex)
      : multi
        ? [...cur, optIndex]
        : [optIndex]
    const next = selections.map((s, i) => (i === qi ? chosen : s))
    setSelections(next)
    autoAdvance.cancel()
    if (picked && !multi && optIndex !== OTHER) {
      autoAdvance.schedule(() => void advance(next))
    }
  }

  const setOther = (qi: number, value: string): void => {
    setOtherText((prev) => {
      const next = [...prev]
      next[qi] = value
      return next
    })
  }

  // Pass the new selection explicitly because setState has not committed it yet.
  const selectionFor = (qi: number, sel = selections): AskAnswerSelection => {
    const picked = (sel[qi] ?? []).filter((i) => i !== OTHER)
    const other = (sel[qi] ?? []).includes(OTHER) ? (otherText[qi] ?? '').trim() : ''
    return other ? { indices: picked, other } : { indices: picked }
  }

  const isAnswered = (qi: number, sel = selections): boolean => {
    const answer = selectionFor(qi, sel)
    return answer.indices.length > 0 || (answer.other ?? '').length > 0
  }

  const total = prompt.questions.length
  const isLast = index === total - 1
  const currentAnswered = useMemo(() => isAnswered(index), [selections, otherText, index])
  const allAnswered = useMemo(
    () => prompt.questions.every((_, i) => isAnswered(i)),
    [otherText, prompt.questions, selections]
  )
  const canAdvance = !submitting && (isLast ? allAnswered : currentAnswered)

  const submit = async (sel: number[][]): Promise<void> => {
    if (!prompt.questions.every((_, i) => isAnswered(i, sel)) || submittingRef.current) {
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    try {
      await onAnswer(prompt.questions.map((_, i) => selectionFor(i, sel)))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const advance = async (sel = selections): Promise<void> => {
    autoAdvance.cancel()
    if (isLast) {
      await submit(sel)
    } else {
      setIndex((i) => Math.min(i + 1, total - 1))
    }
  }

  const q = prompt.questions[index]!
  const otherSelected = (selections[index] ?? []).includes(OTHER)

  return (
    <View style={styles.card}>
      {total > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabs}
          contentContainerStyle={styles.tabsContent}
          keyboardShouldPersistTaps="always"
        >
          {prompt.questions.map((qq, i) => (
            <Pressable
              // oxlint-disable-next-line react-doctor/no-array-index-as-key -- Questions are positional: selections are index-addressed and a prompt never reorders them.
              key={i}
              style={[styles.tab, i === index && styles.tabActive]}
              disabled={submitting}
              onPress={() => {
                autoAdvance.cancel()
                setIndex(i)
              }}
            >
              <Text style={[styles.tabText, i === index && styles.tabTextActive]} numberOfLines={1}>
                {qq.header || `Step ${i + 1}`}
              </Text>
              {isAnswered(i) ? (
                <Check size={11} color={colors.statusGreen} strokeWidth={3} />
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="always">
        <View style={styles.questionRow}>
          <Text style={styles.questionText}>{q.question}</Text>
          <MobileNativeChatCardHeaderAction
            onCollapse={
              onCollapse &&
              (() => {
                autoAdvance.cancel()
                onCollapse()
              })
            }
            disabled={submitting}
          />
        </View>
        {q.options.map((opt, optIndex) => (
          <OptionRow
            key={`${optIndex}:${opt.label}`}
            label={opt.label}
            description={opt.description}
            selected={(selections[index] ?? []).includes(optIndex)}
            multi={q.multiSelect}
            disabled={submitting}
            onPress={() => toggle(index, optIndex, q.multiSelect)}
          />
        ))}
        <OptionRow
          label="Other…"
          selected={otherSelected}
          multi={q.multiSelect}
          disabled={submitting}
          onPress={() => toggle(index, OTHER, q.multiSelect)}
        />
        {otherSelected ? (
          <TextInput
            style={styles.input}
            value={otherText[index]}
            onChangeText={(v) => setOther(index, v)}
            placeholder="Type your answer"
            placeholderTextColor={colors.textMuted}
            multiline
            autoFocus
          />
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={styles.cancel}
          onPress={async () => {
            autoAdvance.cancel()
            if (!submittingRef.current && onCancel) {
              submittingRef.current = true
              setSubmitting(true)
              try {
                await onCancel()
              } finally {
                submittingRef.current = false
                setSubmitting(false)
              }
            }
          }}
          disabled={submitting}
          hitSlop={8}
        >
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        {total > 1 ? (
          <Text style={styles.progress}>
            {index + 1}/{total}
          </Text>
        ) : null}
        <Pressable
          style={[styles.next, !canAdvance && styles.nextDisabled]}
          onPress={() => void advance()}
          disabled={!canAdvance}
        >
          <Text style={[styles.nextText, !canAdvance && styles.nextTextDisabled]}>
            {isLast ? 'Submit' : 'Next'}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

function OptionRow({
  label,
  description,
  selected,
  multi,
  disabled,
  onPress
}: {
  label: string
  description?: string
  selected: boolean
  multi?: boolean
  disabled: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      style={[styles.option, selected && styles.optionSelected]}
      disabled={disabled}
      onPress={onPress}
    >
      {/* Multi-select reads as a checkbox (square); single-select as a radio (circle). */}
      <View
        style={[
          styles.check,
          multi ? styles.checkSquare : styles.checkCircle,
          selected && styles.checkOn
        ]}
      >
        {selected ? <Check size={12} color={colors.bgBase} strokeWidth={3} /> : null}
      </View>
      <View style={styles.optionBody}>
        <Text style={styles.optionLabel}>{label}</Text>
        {description ? (
          <Text style={styles.optionDescription} numberOfLines={3}>
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    maxHeight: 380,
    backgroundColor: colors.bgPanel,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  tabs: {
    flexGrow: 0,
    paddingTop: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  tabsContent: {
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
    alignItems: 'center'
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 36,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tabActive: {
    borderBottomColor: colors.statusGreen
  },
  tabText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  tabTextActive: {
    color: colors.textPrimary
  },
  scroll: {
    paddingHorizontal: spacing.md
  },
  questionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  questionText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    fontWeight: '600',
    marginVertical: spacing.sm
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.card,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    marginBottom: spacing.xs
  },
  optionSelected: {
    borderColor: colors.statusGreen
  },
  check: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  checkCircle: {
    borderRadius: 9
  },
  checkSquare: {
    borderRadius: 4
  },
  checkOn: {
    backgroundColor: colors.statusGreen,
    borderColor: colors.statusGreen
  },
  optionBody: {
    flex: 1,
    gap: 2
  },
  optionLabel: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  optionDescription: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  input: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.card,
    color: colors.textPrimary,
    fontSize: TEXT_INPUT_FONT_SIZE,
    padding: spacing.sm,
    minHeight: 44,
    marginBottom: spacing.xs
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle
  },
  cancel: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm
  },
  cancelText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  progress: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  next: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button,
    backgroundColor: colors.textPrimary
  },
  nextDisabled: {
    backgroundColor: colors.bgRaised
  },
  nextText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  nextTextDisabled: {
    color: colors.textMuted
  }
})
