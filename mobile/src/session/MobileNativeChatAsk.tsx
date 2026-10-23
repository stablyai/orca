import { useMemo, useRef, useState } from 'react'
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Check, ChevronDown } from 'lucide-react-native'
import type { AskAnswerSelection, AskPrompt } from '../../../src/shared/native-chat-ask'
import { colors } from '../theme/mobile-theme'
import { MIN_ASK_BODY_HEIGHT, styles } from './mobile-native-chat-ask-styles'
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
  expanded?: boolean
  compact?: boolean
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
  onCollapse,
  expanded = false,
  compact = false
}: Props): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [selections, setSelections] = useState<number[][]>(() => prompt.questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() => prompt.questions.map(() => ''))
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const scrollRef = useRef<ScrollView>(null)
  const editingOtherRef = useRef(false)
  const cardWidthRef = useRef(0)
  const revealAnswer = (): void => {
    if (editingOtherRef.current) {
      scrollRef.current?.scrollToEnd({ animated: false })
    }
  }
  const autoAdvance = useMobileNativeChatAskAutoAdvance()
  const [layout, setLayout] = useState({ card: 0, header: 0, footer: 0 })
  const recordHeight = (part: 'card' | 'header' | 'footer', height: number): void => {
    setLayout((previous) =>
      height > 0 && previous[part] !== height ? { ...previous, [part]: height } : previous
    )
  }
  // Preserve a scrollable body even when the keyboard leaves less room than the chrome.
  const scrollHeader =
    layout.card > 0 &&
    layout.header > 0 &&
    layout.card - layout.header - StyleSheet.hairlineWidth < MIN_ASK_BODY_HEIGHT
  const scrollFooter =
    layout.card > 0 &&
    layout.footer > 0 &&
    layout.card - (scrollHeader ? 0 : layout.header) - layout.footer - StyleSheet.hairlineWidth <
      MIN_ASK_BODY_HEIGHT

  const selectQuestion = (nextIndex: number): void => {
    autoAdvance.cancel()
    if (nextIndex !== index) {
      if (editingOtherRef.current) {
        editingOtherRef.current = false
        Keyboard.dismiss()
      }
      scrollRef.current?.scrollTo({ y: 0, animated: false })
      setIndex(nextIndex)
    }
  }

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
      selectQuestion(Math.min(index + 1, total - 1))
    }
  }

  const q = prompt.questions[index]!
  const otherSelected = (selections[index] ?? []).includes(OTHER)
  const inlineActions = compact && scrollFooter && !scrollHeader
  const actions = (
    <>
      <Pressable
        accessibilityRole="button"
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
      <Pressable
        accessibilityRole="button"
        style={[styles.next, !canAdvance && styles.nextDisabled]}
        onPress={() => void advance()}
        disabled={!canAdvance}
      >
        <Text style={[styles.nextText, !canAdvance && styles.nextTextDisabled]}>
          {isLast ? 'Submit' : 'Next'}
        </Text>
      </Pressable>
    </>
  )
  const header = (
    <View
      testID="native-chat-ask-header"
      style={styles.header}
      onLayout={(event) => recordHeight('header', event.nativeEvent.layout.height)}
    >
      <Text style={styles.identity} numberOfLines={1}>
        {q.header || 'Question'}
      </Text>
      {total > 1 ? (
        <Text style={styles.progress}>
          {index + 1}/{total}
        </Text>
      ) : null}
      {onCollapse ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="View conversation"
          accessibilityState={{ expanded: true, disabled: submitting }}
          style={styles.contextAction}
          disabled={submitting}
          onPress={() => {
            autoAdvance.cancel()
            Keyboard.dismiss()
            onCollapse()
          }}
        >
          <Text style={styles.contextActionText}>View conversation</Text>
          <ChevronDown size={16} color={colors.textSecondary} />
        </Pressable>
      ) : null}
      {inlineActions ? <View style={styles.inlineActions}>{actions}</View> : null}
    </View>
  )

  const footer = (
    <View
      style={styles.footer}
      onLayout={(event) => recordHeight('footer', event.nativeEvent.layout.height)}
    >
      {actions}
    </View>
  )

  return (
    <View
      style={[styles.card, expanded && styles.expanded]}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout
        if (cardWidthRef.current > 0 && cardWidthRef.current !== width && editingOtherRef.current) {
          Keyboard.dismiss()
        }
        cardWidthRef.current = width
        recordHeight('card', height)
      }}
    >
      {scrollHeader ? null : header}
      <ScrollView
        ref={scrollRef}
        testID="native-chat-ask-body"
        style={styles.scroll}
        keyboardShouldPersistTaps="always"
        onLayout={revealAnswer}
        onContentSizeChange={revealAnswer}
      >
        {scrollHeader ? header : null}
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
                disabled={submitting}
                accessibilityRole="tab"
                accessibilityState={{ selected: i === index, disabled: submitting }}
                aria-selected={i === index}
                onPress={() => selectQuestion(i)}
              >
                <Text
                  style={[styles.tabText, i === index && styles.tabTextActive]}
                  numberOfLines={1}
                >
                  {qq.header || `Step ${i + 1}`}
                </Text>
                {isAnswered(i) ? (
                  <Check size={11} color={colors.textPrimary} strokeWidth={3} />
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        <View style={styles.body}>
          <Text style={styles.questionText}>{q.question}</Text>
          <View
            accessibilityRole={q.multiSelect ? undefined : 'radiogroup'}
            accessibilityLabel={q.question}
          >
            {q.options.map((opt, optIndex) => (
              <OptionRow
                key={`${optIndex}:${opt.label}`}
                label={opt.label}
                description={opt.description}
                selected={(selections[index] ?? []).includes(optIndex)}
                multi={q.multiSelect}
                disabled={submitting}
                onPress={() => {
                  toggle(index, optIndex, q.multiSelect)
                }}
              />
            ))}
            <OptionRow
              label="Other…"
              selected={otherSelected}
              multi={q.multiSelect}
              disabled={submitting}
              onPress={() => {
                toggle(index, OTHER, q.multiSelect)
              }}
            />
          </View>
          {otherSelected ? (
            <TextInput
              accessibilityLabel={`Answer: ${q.question}`}
              style={styles.input}
              value={otherText[index]}
              onChangeText={(v) => setOther(index, v)}
              placeholder="Type your answer"
              placeholderTextColor={colors.textMuted}
              editable={!submitting}
              multiline
              numberOfLines={compact ? 1 : undefined}
              onFocus={() => {
                editingOtherRef.current = true
                revealAnswer()
              }}
              onBlur={() => {
                editingOtherRef.current = false
              }}
              autoFocus
            />
          ) : null}
        </View>
        {scrollFooter && !inlineActions ? footer : null}
      </ScrollView>

      {scrollFooter || inlineActions ? null : footer}
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
      accessibilityRole={multi ? 'checkbox' : 'radio'}
      accessibilityLabel={label}
      accessibilityHint={description}
      accessibilityState={{ checked: selected, disabled }}
      aria-checked={selected}
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
        {description ? <Text style={styles.optionDescription}>{description}</Text> : null}
      </View>
    </Pressable>
  )
}
