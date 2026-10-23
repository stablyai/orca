import { useMemo, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import type { AskAnswerSelection, AskPrompt } from '../../../src/shared/native-chat-ask'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { Button } from '../components/ui/Button'
import { FilterChip } from '../components/ui/FilterChip'
import { ReplyBox } from '../components/ui/ReplyBox'
import { triggerSelection, triggerSuccess } from '../platform/haptics'
import { MobileNativeChatCardHeaderAction } from './MobileNativeChatCardHeaderAction'
import {
  MobileNativeChatPromptCardFrame,
  MobileNativeChatPromptOption,
  promptCardStyles
} from './MobileNativeChatPromptCardFrame'
import { useMobileNativeChatAskAutoAdvance } from './use-mobile-native-chat-ask-auto-advance'

type Props = {
  prompt: AskPrompt
  /** Deliver the chosen answer (per-question option indices + free text) —
   *  index-based so Claude's arrow-navigate selector can be driven by the
   *  option's stable number instead of pasted label text (STA-1860). */
  onAnswer: (selections: AskAnswerSelection[]) => Promise<boolean>
  onCancel?: () => Promise<boolean>
  /** Fold the card to a strip and free Send, writing nothing. */
  onCollapse?: () => void
}

// Sentinel index for the free-text "Other…" row (never a real option index).
const OTHER = -1

/** Native renderer for an agent's AskUserQuestion prompt as a wizard: one
 *  question per step with tabs across the top, a Next button that advances (Send
 *  on the last step), and a Cancel that dismisses the prompt. A single-select pick
 *  moves on by itself, as on desktop. */
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

  // A single-select option answers the question, so the card moves on after a beat that shows
  // it chosen; "Other…" still needs its text.
  const toggle = (qi: number, optIndex: number, multi: boolean): void => {
    // The ref, not `submitting`: a tap can land before the render that disables the rows.
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
    triggerSelection()
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

  // `sel` is an explicit snapshot so a just-made pick isn't lost to the async setState.
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
  const currentAnswered = useMemo(
    () => isAnswered(index),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selections, otherText, index]
  )
  const allAnswered = useMemo(
    () => prompt.questions.every((_, i) => isAnswered(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (await onAnswer(prompt.questions.map((_, i) => selectionFor(i, sel)))) {
        triggerSuccess()
      }
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

  const cancel = async (): Promise<void> => {
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
  }

  return (
    <MobileNativeChatPromptCardFrame bodyStyle="flush">
      {total > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabs}
          contentContainerStyle={styles.tabsContent}
          keyboardShouldPersistTaps="always"
        >
          {prompt.questions.map((qq, i) => (
            <FilterChip
              key={i}
              label={qq.header || `Step ${i + 1}`}
              icon={isAnswered(i) ? Check : undefined}
              active={i === index}
              disabled={submitting}
              onPress={() => {
                autoAdvance.cancel()
                setIndex(i)
              }}
            />
          ))}
        </ScrollView>
      ) : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="always"
      >
        <View style={styles.questionRow}>
          <Text style={styles.questionText} accessibilityRole="header">
            {q.question}
          </Text>
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
        <View style={promptCardStyles.options}>
          {q.options.map((opt, optIndex) => {
            const selected = (selections[index] ?? []).includes(optIndex)
            return (
              <MobileNativeChatPromptOption
                key={`${optIndex}:${opt.label}`}
                label={opt.label}
                description={opt.description}
                mark={q.multiSelect ? 'checkbox' : 'radio'}
                selected={selected}
                disabled={submitting}
                accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                accessibilityState={{ checked: selected }}
                onPress={() => toggle(index, optIndex, q.multiSelect)}
              />
            )
          })}
          <MobileNativeChatPromptOption
            label="Other…"
            mark={q.multiSelect ? 'checkbox' : 'radio'}
            selected={otherSelected}
            disabled={submitting}
            accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: otherSelected }}
            onPress={() => toggle(index, OTHER, q.multiSelect)}
          />
          {otherSelected ? (
            // Its send answers this step, the same as Next or Submit.
            <ReplyBox
              value={otherText[index] ?? ''}
              onChangeText={(v) => setOther(index, v)}
              onSend={() => void advance()}
              placeholder="Type your answer"
              sendAccessibilityLabel={isLast ? 'Submit answers' : 'Next question'}
              sending={submitting}
              autoFocus
              maxLines={4}
            />
          ) : null}
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Button
          label="Cancel"
          variant="plain"
          size="compact"
          disabled={submitting}
          onPress={() => void cancel()}
        />
        {total > 1 ? <Text style={styles.progress}>{`${index + 1} of ${total}`}</Text> : null}
        <Button
          label={isLast ? 'Submit' : 'Next'}
          variant="primary"
          size="compact"
          busy={submitting && isLast}
          disabled={!canAdvance}
          onPress={() => void advance()}
        />
      </View>
    </MobileNativeChatPromptCardFrame>
  )
}

const styles = StyleSheet.create({
  tabs: {
    flexGrow: 0,
    paddingTop: spacing.xs
  },
  tabsContent: {
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
    alignItems: 'center'
  },
  // The card is capped; past it the question and its options scroll above the fixed footer.
  scroll: {
    maxHeight: 300,
    flexShrink: 1
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.md
  },
  questionRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  questionText: {
    ...textStyles.body,
    fontWeight: '600',
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    gap: spacing.sm
  },
  progress: {
    ...textStyles.footnote,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
})
