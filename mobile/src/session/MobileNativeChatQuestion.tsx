import { useMemo, useRef, useState } from 'react'
import { View } from 'react-native'
import { CircleHelp } from 'lucide-react-native'
import { MobileNativeChatCardHeaderAction } from './MobileNativeChatCardHeaderAction'
import { Button } from '../components/ui/Button'
import { ReplyBox } from '../components/ui/ReplyBox'
import { triggerSuccess } from '../platform/haptics'
import {
  MobileNativeChatPromptCardFrame,
  MobileNativeChatPromptOption,
  promptCardStyles
} from './MobileNativeChatPromptCardFrame'
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
  /** Fold the card to a strip and free Send, writing nothing. */
  onCollapse?: () => void
}

/** Renders an agent's choice prompt as a tappable card. Single-select answers
 *  on tap; multi-select toggles then Submits; an always-present text entry lets
 *  the user answer freely (the escape hatch) when the heuristic misreads the
 *  options or none apply. */
export function MobileNativeChatQuestion({
  question,
  onAnswer,
  onCancel,
  onCollapse
}: Props): React.JSX.Element {
  const [selectedOptionIndexes, setSelectedOptionIndexes] = useState<number[]>([])
  const [freeText, setFreeText] = useState(() => question.freeTextInput?.initialValue ?? '')
  const [sending, setSending] = useState(false)
  // The single-select row whose answer is on its way, so the tap shows where it went.
  const [answeringIndex, setAnsweringIndex] = useState<number | null>(null)
  const sendingRef = useRef(false)
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

  const sendAnswer = async (text: string): Promise<boolean> => {
    if (sendingRef.current) {
      return false
    }
    sendingRef.current = true
    setSending(true)
    try {
      const accepted = await onAnswer(text)
      if (accepted) {
        triggerSuccess()
      }
      return accepted
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const answerSingle = async (optionIndex: number): Promise<void> => {
    if (sendingRef.current) {
      return
    }
    const token = question.optionTokens[optionIndex]
    setAnsweringIndex(optionIndex)
    try {
      await sendAnswer(
        token && token.length > 0 ? token : formatQuestionAnswerByIndexes(question, [optionIndex])
      )
    } finally {
      setAnsweringIndex(null)
    }
  }

  const submitMulti = async (): Promise<void> => {
    if (selectedOptionIndexes.length === 0) {
      return
    }
    const answer =
      question.freeTextToken && answerText.length > 0
        ? formatQuestionAnswerWithOtherByIndexes(question, selectedOptionIndexes, answerText)
        : formatQuestionAnswerByIndexes(question, selectedOptionIndexes)
    if (await sendAnswer(answer)) {
      setFreeText('')
    }
  }

  const submitFreeText = async (text = answerText): Promise<void> => {
    if (!allowOther || (text.length === 0 && !question.freeTextInput?.allowEmpty)) {
      return
    }
    const answer =
      question.multiSelect && question.freeTextToken && selectedOptionIndexes.length > 0
        ? formatQuestionAnswerWithOtherByIndexes(question, selectedOptionIndexes, text)
        : formatQuestionFreeTextAnswer(question, text)
    if (await sendAnswer(answer)) {
      setFreeText('')
    }
  }

  // A declared one-line input (Pi's `input`) sends on Return, as its single-line field did; a
  // pasted block keeps its words on one line.
  const singleLine = question.freeTextInput ? question.freeTextInput.multiline !== true : false
  const changeFreeText = (next: string): void => {
    if (!singleLine || !next.includes('\n')) {
      setFreeText(next)
      return
    }
    if (next === `${freeText}\n`) {
      void submitFreeText(question.freeTextInput?.allowEmpty ? freeText : freeText.trim())
      return
    }
    setFreeText(next.replace(/\s*\n\s*/g, ' '))
  }

  const canSubmitMulti = selectedOptionIndexes.length > 0 && !sending

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
    <MobileNativeChatPromptCardFrame
      icon={CircleHelp}
      title={question.question}
      headerAction={
        <MobileNativeChatCardHeaderAction
          prompt={question.prompt}
          onCancel={onCancel}
          onCollapse={onCollapse}
          disabled={sending}
        />
      }
    >
      {hasOptions ? (
        <View style={promptCardStyles.options}>
          {optionRows.map(({ label, description, key }, optIndex) => {
            const isSelected = selectedOptionIndexes.includes(optIndex)
            return (
              <MobileNativeChatPromptOption
                key={key}
                label={label}
                description={description}
                mark={question.multiSelect ? 'checkbox' : null}
                selected={question.multiSelect ? isSelected : false}
                busy={answeringIndex === optIndex}
                disabled={sending}
                accessibilityRole={question.multiSelect ? 'checkbox' : 'button'}
                accessibilityState={question.multiSelect ? { checked: isSelected } : undefined}
                onPress={() => (question.multiSelect ? toggle(optIndex) : answerSingle(optIndex))}
              />
            )
          })}
        </View>
      ) : null}

      {question.multiSelect && hasOptions ? (
        <Button
          label={`Submit${selectedOptionIndexes.length > 0 ? ` (${selectedOptionIndexes.length})` : ''}`}
          accessibilityLabel="Submit selected options"
          variant="primary"
          size="compact"
          block
          busy={sending && answeringIndex === null && selectedOptionIndexes.length > 0}
          disabled={!canSubmitMulti}
          onPress={() => void submitMulti()}
        />
      ) : null}

      {allowOther ? (
        <ReplyBox
          value={freeText}
          onChangeText={changeFreeText}
          onSend={() => void submitFreeText()}
          placeholder={
            question.freeTextInput?.placeholder ??
            (hasOptions ? 'Or type a reply…' : 'Type your reply…')
          }
          sendAccessibilityLabel="Send reply"
          sending={sending && answeringIndex === null && !question.multiSelect}
          allowEmpty={question.freeTextInput?.allowEmpty === true}
          maxLines={singleLine ? 1 : 5}
          returnKeyType={singleLine ? 'send' : undefined}
        />
      ) : null}
    </MobileNativeChatPromptCardFrame>
  )
}
