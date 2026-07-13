import { useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { formatCompleteAskAnswer, type AskPrompt } from './mobile-native-chat-ask'

type Props = {
  prompt: AskPrompt
  onAnswer: (text: string) => Promise<boolean>
  onCancel?: () => Promise<boolean>
}

const OTHER = '__other__'

/** Native renderer for an agent's AskUserQuestion prompt as a wizard: one
 *  question per step with tabs across the top, a Next button that advances (Send
 *  on the last step), and a Cancel that dismisses the prompt. Neutral styling
 *  with a subtle green accent on the active choice to match the rest of the app. */
export function MobileNativeChatAsk({ prompt, onAnswer, onCancel }: Props): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [selections, setSelections] = useState<string[][]>(() => prompt.questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() => prompt.questions.map(() => ''))
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setSelections((prev) => {
      const next = prev.map((s) => [...s])
      const cur = next[qi] ?? []
      if (multi) {
        next[qi] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
      } else {
        next[qi] = cur.includes(label) ? [] : [label]
      }
      return next
    })
  }

  const setOther = (qi: number, value: string): void => {
    setOtherText((prev) => {
      const next = [...prev]
      next[qi] = value
      return next
    })
  }

  const answerFor = (qi: number): string => {
    const picked = (selections[qi] ?? []).filter((l) => l !== OTHER)
    const other = (selections[qi] ?? []).includes(OTHER) ? (otherText[qi] ?? '').trim() : ''
    return [...picked, other].filter((p) => p.length > 0).join(', ')
  }

  const total = prompt.questions.length
  const isLast = index === total - 1
  const currentAnswered = useMemo(
    () => answerFor(index).length > 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selections, otherText, index]
  )
  const completeAnswer = useMemo(
    () => formatCompleteAskAnswer(prompt.questions.map((_, i) => answerFor(i))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [otherText, prompt.questions, selections]
  )
  const canAdvance = !submitting && (isLast ? completeAnswer !== null : currentAnswered)

  const submit = async (): Promise<void> => {
    if (!completeAnswer || submittingRef.current) {
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    try {
      await onAnswer(completeAnswer)
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const advance = async (): Promise<void> => {
    if (isLast) {
      await submit()
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
              key={i}
              style={[styles.tab, i === index && styles.tabActive]}
              onPress={() => setIndex(i)}
            >
              <Text style={[styles.tabText, i === index && styles.tabTextActive]} numberOfLines={1}>
                {qq.header || `Step ${i + 1}`}
              </Text>
              {answerFor(i).length > 0 ? (
                <Check size={11} color={colors.statusGreen} strokeWidth={3} />
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="always">
        <Text style={styles.questionText}>{q.question}</Text>
        {q.options.map((opt, optIndex) => (
          <OptionRow
            key={`${optIndex}:${opt.label}`}
            label={opt.label}
            description={opt.description}
            selected={(selections[index] ?? []).includes(opt.label)}
            multi={q.multiSelect}
            onPress={() => toggle(index, opt.label, q.multiSelect)}
          />
        ))}
        <OptionRow
          label="Other…"
          selected={otherSelected}
          multi={q.multiSelect}
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
          onPress={advance}
          disabled={!canAdvance}
        >
          <Text style={[styles.nextText, !canAdvance && styles.nextTextDisabled]}>
            {isLast ? 'Send answer' : 'Next'}
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
  onPress
}: {
  label: string
  description?: string
  selected: boolean
  multi?: boolean
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable style={[styles.option, selected && styles.optionSelected]} onPress={onPress}>
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
  questionText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize + 1,
    fontWeight: '600',
    marginVertical: spacing.sm
  },
  option: {
    flexDirection: 'row',
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
    justifyContent: 'center',
    marginTop: 1
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
    fontSize: typography.bodySize,
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
