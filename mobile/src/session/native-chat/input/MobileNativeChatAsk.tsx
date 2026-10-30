import { useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import type { AskAnswerSelection } from '../../../../../src/shared/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import type { AgentJournalFreeTextInput } from '../../../../../src/shared/agent-session-journal-types'
import {
  askAcceptsEmptyAnswer,
  askConfirmAction,
  askConfirmLabel,
  askTypedText,
  toggleAskOption
} from '../../../../../src/shared/native-chat-ask-card-rules'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { MessageBox } from '../../../components/composer-input/MessageBox'
import { MobileNativeChatCardHeaderAction } from '../../MobileNativeChatCardHeaderAction'
import { useMobileNativeChatAskAutoAdvance } from './use-mobile-native-chat-ask-auto-advance'
import { MobileNativeChatAskOptionRow } from './MobileNativeChatAskOptionRow'
import { useMobileNativeChatReplyScroll } from './use-mobile-native-chat-reply-scroll'

type Props = {
  prompt: AskPrompt
  // Use option indices so Claude’s selector can navigate without pasting labels.
  onAnswer: (selections: AskAnswerSelection[]) => Promise<boolean>
  onCancel?: () => Promise<boolean>
  // Collapse writes nothing to the agent.
  onCollapse?: () => void
  /** Per question; structured prompts hide "Other…" where the provider takes no free text. */
  allowOther?: readonly boolean[]
  freeTextInputs?: readonly (AgentJournalFreeTextInput | undefined)[]
}

function confirmLabels(t: Translate) {
  return {
    submit: t('chat.ask.submit', 'Submit'),
    next: t('chat.ask.next', 'Next'),
    skip: t('chat.ask.skip', 'Skip')
  }
}

// Sentinel index for the free-text "Other…" row (never a real option index).
const OTHER = -1

export function MobileNativeChatAsk({
  prompt,
  onAnswer,
  onCancel,
  onCollapse,
  allowOther,
  freeTextInputs
}: Props): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { scrollRef, inputRef, revealReply, onViewportLayout } = useMobileNativeChatReplyScroll()
  const [index, setIndex] = useState(0)
  const [selections, setSelections] = useState<number[][]>(() => prompt.questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() =>
    prompt.questions.map((_, qi) => freeTextInputs?.[qi]?.initialValue ?? '')
  )
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const autoAdvance = useMobileNativeChatAskAutoAdvance()
  // Open each step at its question and end the last step's edit, so no typing lands out of view.
  const showStep = (next: (current: number) => number): void => {
    inputRef.current?.blur()
    scrollRef.current?.scrollTo({ y: 0, animated: false })
    setIndex(next)
  }

  // A question with no options is answered by typing alone.
  const typesOnly = (qi: number): boolean =>
    allowOther?.[qi] !== false && prompt.questions[qi]?.options.length === 0
  const acceptsEmpty = (qi: number): boolean =>
    askAcceptsEmptyAnswer(prompt.questions[qi], freeTextInputs?.[qi])

  // Delay single-select advance to show the choice; Other still needs text.
  const toggle = (qi: number, optIndex: number, multi: boolean): void => {
    // Block same-frame taps before disabled state renders.
    if (submittingRef.current) {
      return
    }
    const cur = selections[qi] ?? []
    const picked = !cur.includes(optIndex)
    const next = selections.map((s, i) => (i === qi ? toggleAskOption(cur, optIndex, multi) : s))
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
    const typed = typesOnly(qi) || (sel[qi] ?? []).includes(OTHER)
    const other = typed ? askTypedText(otherText[qi] ?? '', freeTextInputs?.[qi]) : ''
    return other || acceptsEmpty(qi) ? { indices: picked, other } : { indices: picked }
  }

  const isAnswered = (qi: number, sel = selections): boolean => {
    const answer = selectionFor(qi, sel)
    return answer.indices.length > 0 || (answer.other ?? '').length > 0 || acceptsEmpty(qi)
  }

  const total = prompt.questions.length
  const isLast = index === total - 1
  const anyAnswered = (sel = selections): boolean =>
    prompt.questions.some((_, i) => isAnswered(i, sel))

  const submit = async (sel: number[][]): Promise<void> => {
    if (!anyAnswered(sel) || submittingRef.current) {
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
      showStep((i) => Math.min(i + 1, total - 1))
    }
  }

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

  const confirm = (): void => {
    const action = askConfirmAction({ isLast, anyAnswered: anyAnswered() })
    if (action === 'cancel') {
      void cancel()
    } else if (action === 'proceed') {
      void advance()
    }
  }

  const q = prompt.questions[index]!
  const otherAllowed = allowOther?.[index] !== false
  const otherSelected = (selections[index] ?? []).includes(OTHER)
  const freeTextInput = freeTextInputs?.[index]
  const currentAnswered = isAnswered(index)

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
                showStep(() => i)
              }}
            >
              <Text style={[styles.tabText, i === index && styles.tabTextActive]} numberOfLines={1}>
                {qq.header || t('chat.ask.step', 'Step {{step}}', { step: i + 1 })}
              </Text>
              {isAnswered(i) ? (
                <Check size={11} color={colors.statusGreen} strokeWidth={3} />
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <ScrollView
        ref={scrollRef}
        onLayout={onViewportLayout}
        style={styles.scroll}
        keyboardShouldPersistTaps="always"
      >
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
          <MobileNativeChatAskOptionRow
            key={`${optIndex}:${opt.label}`}
            label={opt.label}
            description={opt.description}
            selected={(selections[index] ?? []).includes(optIndex)}
            multi={q.multiSelect}
            disabled={submitting}
            onPress={() => toggle(index, optIndex, q.multiSelect)}
          />
        ))}
        {otherAllowed && !typesOnly(index) ? (
          <MobileNativeChatAskOptionRow
            label={t('chat.ask.other', 'Other…')}
            selected={otherSelected}
            multi={q.multiSelect}
            disabled={submitting}
            onPress={() => toggle(index, OTHER, q.multiSelect)}
          />
        ) : null}
        {otherSelected || typesOnly(index) ? (
          <MessageBox
            inputRef={inputRef}
            onFocus={revealReply}
            style={styles.other}
            value={otherText[index] ?? ''}
            onChangeText={(v) => setOther(index, v)}
            placeholder={
              freeTextInput?.placeholder ?? t('chat.ask.answerPlaceholder', 'Type your answer')
            }
            // A declared input (Pi's `input`) is one line unless it asks for more, as on desktop.
            multiline={freeTextInput ? freeTextInput.multiline === true : true}
            autoFocus
          />
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={styles.cancel}
          onPress={() => void cancel()}
          disabled={submitting}
          hitSlop={8}
        >
          <Text style={styles.cancelText}>{t('common.cancel', 'Cancel')}</Text>
        </Pressable>
        {total > 1 ? (
          <Text style={styles.progress}>
            {index + 1}/{total}
          </Text>
        ) : null}
        <Pressable
          style={[styles.next, !currentAnswered && styles.nextSkip]}
          onPress={confirm}
          disabled={submitting}
        >
          <Text style={[styles.nextText, !currentAnswered && styles.nextSkipText]}>
            {confirmLabels(t)[askConfirmLabel(currentAnswered, isLast)]}
          </Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    flexShrink: 1,
    minHeight: 0,
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
  other: {
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
  nextSkip: {
    backgroundColor: colors.bgRaised
  },
  nextText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  nextSkipText: {
    color: colors.textMuted
  }
}))
