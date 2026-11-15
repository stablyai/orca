import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Keyboard, Pressable, ScrollView, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import {
  nativeChatAnswerOperationEvidence,
  type NativeChatAnswerOperation,
  type NativeChatAnswerSource,
  type AskAnswerSelection
} from '../../../../../../src/shared/native-chat/input/questions/native-chat-ask-answer'
import type { AskPrompt } from '../../../../../../src/shared/native-chat/input/questions/native-chat-ask-types'
import type { AgentJournalFreeTextInput } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import {
  askAcceptsEmptyAnswer,
  askConfirmAction,
  askQuestionShowsPreviews,
  askConfirmLabel,
  askTypedText,
  askUnansweredRequired,
  toggleAskOption
} from '../../../../../../src/shared/native-chat/input/questions/native-chat-ask-card-rules'
import { colors, pressedStyle } from '../../../../theme/mobile-theme'
import { triggerSelection } from '../../../../platform/haptics/haptics'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { MessageBox } from '../../../../components/composer-input/MessageBox'
import { MobilePendingButton } from '../../../../components/controls/MobilePendingButton'
import { MobileNativeChatCardHeaderAction } from './MobileNativeChatCardHeaderAction'
import { MobileNativeChatQuestionText } from '../../transcript/message-content/MobileNativeChatQuestionText'
import { useMobileNativeChatAskAutoAdvance } from './use-mobile-native-chat-ask-auto-advance'
import { MobileNativeChatAskOptionRow } from './MobileNativeChatAskOptionRow'
import { MobileNativeChatOptionPreviewSheet } from '../session-options/MobileNativeChatOptionPreviewSheet'
import { mobileNativeChatAskStyles as styles } from './MobileNativeChatAsk.styles'
import { useMobileNativeChatReplyScroll } from './use-mobile-native-chat-reply-scroll'

type Props = {
  prompt: AskPrompt
  answerSendSource?: NativeChatAnswerSource
  answerPending?: boolean
  // Use option indices so Claude’s selector can navigate without pasting labels.
  onAnswer: (selections: AskAnswerSelection[], onCreated?: (id: string) => void) => Promise<boolean>
  onCancel?: () => Promise<boolean>
  /** The footer's Cancel, named for what `onCancel` does there. */
  cancelLabel?: string
  // Collapse writes nothing to the agent.
  onCollapse?: () => void
  /** Per question; structured prompts hide "Other…" where the provider takes no free text. */
  allowOther?: readonly boolean[]
  freeTextInputs?: readonly (AgentJournalFreeTextInput | undefined)[]
  /** Tapping a choice is the whole answer: no Cancel or Skip, only the fold chevron. */
  choiceOnly?: true
  /** Under the question: what the card's owner adds, e.g. a worker prompt's countdown. */
  note?: ReactNode
  /** Each question's identity: when the prompt drops one (answered elsewhere), the rest keep their picks. */
  questionKeys?: readonly string[]
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
  answerPending = false,
  answerSendSource,
  onAnswer,
  onCancel,
  cancelLabel,
  onCollapse,
  allowOther,
  freeTextInputs,
  choiceOnly,
  note,
  questionKeys
}: Props): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { scrollRef, inputRef, revealReply, onViewportLayout } = useMobileNativeChatReplyScroll()
  const [index, setIndex] = useState(0)
  const [viewedOption, setViewedOption] = useState<number | null>(null)
  // Which footer control started the in-flight operation, so its busy state lands there.
  const [busyControl, setBusyControl] = useState<'confirm' | 'cancel'>('confirm')
  const [selections, setSelections] = useState<number[][]>(() => prompt.questions.map(() => []))
  const [otherText, setOtherText] = useState<string[]>(() =>
    prompt.questions.map((_, qi) => freeTextInputs?.[qi]?.initialValue ?? '')
  )
  const [operation, setOperation] = useState<NativeChatAnswerOperation | null>(null)
  const operationRef = useRef<NativeChatAnswerOperation | null>(null)
  const operationId = operation?.clientMessageId
  const evidence = useMemo(
    () =>
      nativeChatAnswerOperationEvidence(
        operationId,
        answerSendSource?.messages ?? [],
        answerSendSource?.submissions
      ),
    [operationId, answerSendSource?.messages, answerSendSource?.submissions]
  )
  const isLocalPending = (current: NativeChatAnswerOperation | null): boolean =>
    current !== null &&
    ((current.clientMessageId === operationId ? evidence : undefined) ?? current.inFlight)
  const sending = operation?.inFlight === true && isLocalPending(operation)
  const submitting = isLocalPending(operation) || answerPending
  const cancelBusy = busyControl === 'cancel' && isLocalPending(operation)
  const confirmBusy = submitting && !cancelBusy
  const autoAdvance = useMobileNativeChatAskAutoAdvance(submitting)
  const [shownKeys, setShownKeys] = useState(questionKeys)
  // Counts lines answered elsewhere while on screen: the line that takes over opens as showStep opens it.
  const [stepsGone, setStepsGone] = useState(0)
  useEffect(() => {
    if (stepsGone > 0) {
      inputRef.current?.blur()
      scrollRef.current?.scrollTo({ y: 0, animated: false })
    }
  }, [stepsGone, inputRef, scrollRef])
  if (questionKeys && shownKeys && questionKeys.join('\n') !== shownKeys.join('\n')) {
    const carry = <T,>(values: readonly T[], fill: (qi: number) => T): T[] =>
      questionKeys.map((key, qi) => {
        const at = shownKeys.indexOf(key)
        return at === -1 ? fill(qi) : values[at]!
      })
    // A pending auto-advance holds the old lines' picks.
    autoAdvance.cancel()
    setShownKeys(questionKeys)
    setSelections(carry(selections, () => []))
    setOtherText(carry(otherText, (qi) => freeTextInputs?.[qi]?.initialValue ?? ''))
    const at = questionKeys.indexOf(shownKeys[index]!)
    setIndex(Math.max(0, at))
    if (at === -1) {
      setStepsGone((count) => count + 1)
    }
    setViewedOption(null)
    // React renders again at once with the carried state; this pass's lines no longer match it.
    return null
  }
  // Open each step at its question and end the last step's edit, so no typing lands out of view.
  const showStep = (next: (current: number) => number): void => {
    setViewedOption(null)
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
  const toggle = (qi: number, optIndex: number, multi: boolean, choosing = false): void => {
    // Block same-frame taps before disabled state renders.
    if (isLocalPending(operationRef.current) || answerPending) {
      return
    }
    const cur = selections[qi] ?? []
    // Preview choices wait for Submit so inspecting alternatives never commits an answer.
    const keep = optIndex !== OTHER && askQuestionShowsPreviews(prompt.questions[qi])
    const picked = !cur.includes(optIndex)
    const next = selections.map((s, i) =>
      i === qi ? toggleAskOption(cur, optIndex, multi, keep || choosing) : s
    )
    setSelections(next)
    autoAdvance.cancel()
    if (picked && !multi && optIndex !== OTHER && !keep) {
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
    if (!anyAnswered(sel) || isLocalPending(operationRef.current) || answerPending) {
      return
    }
    const current: NativeChatAnswerOperation = { inFlight: true }
    operationRef.current = current
    setOperation(current)
    setBusyControl('confirm')
    triggerSelection()
    try {
      await onAnswer(
        prompt.questions.map((_, i) => selectionFor(i, sel)),
        (id) => {
          current.clientMessageId = id
          if (operationRef.current === current) {
            setOperation({ ...current })
          }
        }
      )
    } finally {
      current.inFlight = false
      if (operationRef.current === current) {
        setOperation({ ...current })
      }
    }
  }

  const advance = async (sel = selections): Promise<void> => {
    autoAdvance.cancel()
    const unanswered = askUnansweredRequired(prompt.questions, (i) => isAnswered(i, sel))
    if (isLast && unanswered !== -1) {
      showStep(() => unanswered)
    } else if (isLast) {
      await submit(sel)
    } else {
      showStep((i) => Math.min(i + 1, total - 1))
    }
  }

  const cancel = async (control: 'confirm' | 'cancel'): Promise<void> => {
    autoAdvance.cancel()
    if (!(operationRef.current?.inFlight && isLocalPending(operationRef.current)) && onCancel) {
      const current: NativeChatAnswerOperation = { inFlight: true }
      operationRef.current = current
      setOperation(current)
      setBusyControl(control)
      triggerSelection()
      try {
        await onCancel()
      } finally {
        current.inFlight = false
        if (operationRef.current === current) {
          setOperation({ ...current })
        }
      }
    }
  }

  const confirm = (): void => {
    const action = askConfirmAction({ isLast, anyAnswered: anyAnswered(), waitsForAnswer })
    if (action === 'cancel') {
      void cancel('confirm')
    } else if (action === 'proceed') {
      void advance()
    }
  }

  const q = prompt.questions[index]!
  const otherAllowed = allowOther?.[index] !== false
  const otherSelected = (selections[index] ?? []).includes(OTHER)
  const freeTextInput = freeTextInputs?.[index]
  const currentAnswered = isAnswered(index)
  // A required question offers Next or Submit, never Skip, and waits until it is answered.
  const waitsForAnswer = q.required === true && !currentAnswered
  const confirmLabel = askConfirmLabel(currentAnswered || waitsForAnswer, isLast, anyAnswered())
  const confirmSkips = confirmLabel === 'skip'
  const confirmBlocked =
    askConfirmAction({ isLast, anyAnswered: anyAnswered(), waitsForAnswer }) === 'stay'

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
              style={({ pressed }) => [
                styles.tab,
                i === index && styles.tabActive,
                pressed && pressedStyle
              ]}
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
          <MobileNativeChatQuestionText
            tone="medium"
            content={q.question}
            style={styles.questionText}
          />
          <MobileNativeChatCardHeaderAction
            onCollapse={
              onCollapse &&
              (() => {
                autoAdvance.cancel()
                onCollapse()
              })
            }
            disabled={sending}
          />
        </View>
        {note}
        {q.options.map((opt, optIndex) => (
          <MobileNativeChatAskOptionRow
            key={`${optIndex}:${opt.label}`}
            label={opt.label}
            description={opt.description}
            recommended={opt.recommended}
            preview={opt.preview}
            onPreview={() => {
              autoAdvance.cancel()
              inputRef.current?.blur()
              Keyboard.dismiss()
              setViewedOption(optIndex)
            }}
            selected={(selections[index] ?? []).includes(optIndex)}
            multi={q.multiSelect}
            disabled={submitting}
            // A choice-only card has no Submit: the chosen choice is the control that sends.
            pending={choiceOnly && confirmBusy && (selections[index] ?? []).includes(optIndex)}
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

      {choiceOnly ? (
        <View style={styles.choiceOnlyEnd} />
      ) : (
        <View style={styles.footer}>
          <MobilePendingButton
            label={cancelLabel ?? t('common.cancel', 'Cancel')}
            pending={cancelBusy}
            disabled={sending}
            onPress={() => void cancel('cancel')}
            hitSlop={8}
            style={styles.cancel}
            labelStyle={styles.cancelText}
            spinnerColor={colors.textPrimary}
          />
          {total > 1 ? (
            <Text style={styles.progress}>
              {index + 1}/{total}
            </Text>
          ) : null}
          <MobilePendingButton
            label={confirmLabels(t)[confirmLabel]}
            pending={confirmBusy}
            disabled={submitting || confirmBlocked}
            onPress={confirm}
            style={[
              styles.next,
              confirmSkips && styles.nextSkip,
              confirmBlocked && styles.nextBlocked
            ]}
            labelStyle={[styles.nextText, confirmSkips && styles.nextSkipText]}
            spinnerColor={confirmSkips ? colors.textPrimary : colors.bgBase}
          />
        </View>
      )}
      <MobileNativeChatOptionPreviewSheet
        options={q.options}
        viewedIndex={viewedOption}
        selected={selections[index] ?? []}
        disabled={submitting}
        onView={setViewedOption}
        onClose={() => setViewedOption(null)}
        onChoose={(optionIndex) => {
          setViewedOption(null)
          toggle(index, optionIndex, q.multiSelect, true)
        }}
      />
    </View>
  )
}
