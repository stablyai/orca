// The answer card's picks and typed words per question, seeded from a saved draft when its owner keeps
// one (an item's card, so closing the item doesn't lose them), and reported back as they change.
import { useRef, useState } from 'react'
import type { AgentJournalFreeTextInput } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AskPrompt } from '../../../../../../src/shared/native-chat/input/questions/native-chat-ask-types'

/** One question's unsent picks (Other… is -1) and typed words. */
export type MobileNativeChatAskDraft = { picks: readonly number[]; other: string }

/** Unsent answers kept by question key outside the card: `saved` seeds it, and `onChange` gets every
 *  shown question's answer after each edit, so the kept copy is always the whole card. */
export type MobileNativeChatAskDrafts = {
  saved?: Readonly<Record<string, MobileNativeChatAskDraft>>
  onChange: (questions: Record<string, MobileNativeChatAskDraft>) => void
}

export function useMobileNativeChatAskAnswers(
  prompt: AskPrompt,
  freeTextInputs: readonly (AgentJournalFreeTextInput | undefined)[] | undefined,
  questionKeys: readonly string[] | undefined,
  drafts: MobileNativeChatAskDrafts | undefined
) {
  // `keys`: the lines being shown, which differ from `questionKeys` while a line is carried over.
  const seed = (qi: number, keys = questionKeys): { picks: number[]; other: string } => {
    const key = keys?.[qi]
    const saved = key === undefined ? undefined : drafts?.saved?.[key]
    return {
      picks: [...(saved?.picks ?? [])],
      other: saved?.other ?? freeTextInputs?.[qi]?.initialValue ?? ''
    }
  }
  const [selections, setSelections] = useState<number[][]>(() =>
    prompt.questions.map((_, qi) => seed(qi).picks)
  )
  const [otherText, setOtherText] = useState<string[]>(() =>
    prompt.questions.map((_, qi) => seed(qi).other)
  )
  // Each question's latest answer by key, as the edits set it, so a save never reads an older render's.
  const latest = useRef<Record<string, MobileNativeChatAskDraft>>({ ...drafts?.saved })
  const save = (qi: number, change: Partial<MobileNativeChatAskDraft>): void => {
    const key = questionKeys?.[qi]
    if (!drafts || !questionKeys || key === undefined) {
      return
    }
    const shown = (at: number): MobileNativeChatAskDraft => ({
      picks: selections[at] ?? [],
      other: otherText[at] ?? ''
    })
    latest.current[key] = { ...shown(qi), ...latest.current[key], ...change }
    drafts.onChange(
      Object.fromEntries(questionKeys.map((k, at) => [k, latest.current[k] ?? shown(at)]))
    )
  }
  /** Sets every question's picks after one question's change. */
  const setPicks = (qi: number, next: number[][]): void => {
    setSelections(next)
    save(qi, { picks: next[qi] ?? [] })
  }
  const setOther = (qi: number, value: string): void => {
    setOtherText((prev) => {
      const next = [...prev]
      next[qi] = value
      return next
    })
    save(qi, { other: value })
  }
  return { selections, setSelections, setPicks, otherText, setOtherText, setOther, seed }
}
