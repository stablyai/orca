import { formatFinalTranscriptSegment } from '../../shared/dictation-final-segments'

export function appendMobileDictationFinal(
  fragments: string[],
  text: string | undefined,
  preserveExactText: boolean
): void {
  if (text === undefined || text === '') {
    return
  }
  fragments.push(preserveExactText ? text : formatFinalTranscriptSegment(text, fragments.join('')))
}

export function finishMobileDictationText(
  fragments: string[],
  partialText: string,
  preserveExactText: boolean
): string {
  // Why: Soniox emits whitespace/punctuation tokens while local models may
  // emit word-only segments; mobile must share desktop's boundary contract.
  const committed = fragments.join('')
  if (preserveExactText) {
    return `${committed}${partialText}`
  }
  return `${committed}${formatFinalTranscriptSegment(partialText, committed)}`.trim()
}
