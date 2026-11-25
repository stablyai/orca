// A record line's translated sentence, with its names marked as `<tool>`, `<task>` or `<answer>`.

// Stand-ins no translation holds: recordSentenceParts swaps in the names after the split.
export const RECORD_SENTENCE_KEEP = { tool: '\u0001', task: '\u0002', answer: '\u0003' } as const

type RecordValues = Partial<Record<keyof typeof RECORD_SENTENCE_KEEP, string>>

/** The sentence split at its marks, filled after the split so a name can't add one. */
export function recordSentenceParts(
  sentence: string,
  values: RecordValues
): { text: string; name: string | null }[] {
  const fill = (part: string) =>
    part
      .replaceAll(RECORD_SENTENCE_KEEP.tool, () => values.tool ?? '')
      .replaceAll(RECORD_SENTENCE_KEEP.task, () => values.task ?? '')
      .replaceAll(RECORD_SENTENCE_KEEP.answer, () => values.answer ?? '')
  return sentence
    .split(/(<tool>.*?<\/tool>|<task>.*?<\/task>|<answer>.*?<\/answer>)/)
    .filter(Boolean)
    .map((part) => {
      const named = /^<(tool|task|answer)>(.*)<\/\1>$/.exec(part)
      return { text: fill(named ? named[2]! : part), name: named ? named[1]! : null }
    })
}
