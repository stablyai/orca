// Pure scheduling math for sending a multi-question AskUserQuestion answer to a
// Claude agent. Mirrors the desktop `nativeChatQuestionOffsets`
// (src/renderer/src/components/native-chat/native-chat-runtime-send.ts).
//
// Why: Claude Code's AskUserQuestion is a MULTI-STEP prompt — it renders one
// question at a time, and each Enter advances to the next (the final Enter
// submits the whole thing). So a multi-line answer (one line per question, as
// `formatAskAnswer` builds it) must be sent as a per-question sequence: write a
// question's body, then its own Enter after the submit delay, paced so each
// Enter lands on its rendered question and only the LAST Enter submits.

// Body→Enter gap. Matches the desktop NATIVE_CHAT_SUBMIT_DELAY_MS: a short gap
// fires Enter before a busy agent has landed the paste, submitting an empty box.
export const MOBILE_NATIVE_CHAT_SUBMIT_DELAY_MS = 500

// Extra buffer on top of the body→Enter gap so the next question step renders
// before its body is written. Matches the desktop NATIVE_CHAT_ADVANCE_BUFFER_MS.
export const MOBILE_NATIVE_CHAT_ADVANCE_BUFFER_MS = 300

/** Per-question wall-clock cadence: body→Enter gap plus the advance buffer. */
export const MOBILE_NATIVE_CHAT_QUESTION_STEP_MS =
  MOBILE_NATIVE_CHAT_SUBMIT_DELAY_MS + MOBILE_NATIVE_CHAT_ADVANCE_BUFFER_MS

/** For question index `i` (0-based) return the offsets (ms from the start of the
 *  send) at which to write its framed body and its Enter. Exactly one Enter per
 *  question; the last Enter submits the prompt. */
export function mobileNativeChatQuestionOffsets(index: number): {
  bodyAt: number
  enterAt: number
} {
  const bodyAt = index * MOBILE_NATIVE_CHAT_QUESTION_STEP_MS
  return { bodyAt, enterAt: bodyAt + MOBILE_NATIVE_CHAT_SUBMIT_DELAY_MS }
}

/** Schedule a paced per-question answer sequence for Claude: for each `line`
 *  (one question's answer), write its body (`enter:false`) then its own Enter
 *  (`enter:true`) at the offsets above, so each Enter lands on its rendered
 *  question and only the last submits. `writeBody`/`writeEnter` perform the
 *  actual terminal send (kept out of here so this stays IO-free/testable).
 *  Returns the scheduled timer ids so the caller can cancel them on
 *  unmount/Stop/new answer. */
export function scheduleMobileClaudeAnswer(
  lines: string[],
  writeBody: (line: string) => void,
  writeEnter: () => void
): ReturnType<typeof setTimeout>[] {
  const timers: ReturnType<typeof setTimeout>[] = []
  lines.forEach((line, index) => {
    const { bodyAt, enterAt } = mobileNativeChatQuestionOffsets(index)
    timers.push(setTimeout(() => writeBody(line), bodyAt))
    timers.push(setTimeout(() => writeEnter(), enterAt))
  })
  return timers
}
