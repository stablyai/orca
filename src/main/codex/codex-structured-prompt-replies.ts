import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CODEX_PROMPT_MAX_ANSWER_BYTES } from './codex-prompt-registry-bounds'
import {
  CODEX_USER_INPUT_METHOD,
  type CodexPendingPrompt,
  type CodexPromptClaim,
  type CodexPromptRegistry
} from './codex-prompt-registry'
export {
  codexJournalPromptIdPart,
  MAX_CODEX_PROMPT_REGISTRY_ENTRIES,
  MAX_CODEX_PROMPT_JOURNAL_BINDINGS,
  MAX_CODEX_PROMPT_REGISTRY_BYTES,
  encodeCodexJournalQuestionOptionId
} from './codex-prompt-registry-bounds'
export {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  CodexPromptRegistry,
  isCodexPromptMethod,
  type CodexPendingPrompt,
  type CodexPromptClaim
} from './codex-prompt-registry'

/** The decisions Codex accepts for both approval requests. Anything else is a
 *  client-supplied option id that never came from a Codex prompt. */
export const CODEX_APPROVAL_DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'] as const
export type CodexApprovalDecision = (typeof CODEX_APPROVAL_DECISIONS)[number]

function isCodexApprovalDecision(optionId: string): optionId is CodexApprovalDecision {
  return CODEX_APPROVAL_DECISIONS.some((decision) => decision === optionId)
}

/** A user-input request can carry several questions but takes ONE reply, so an
 *  option id has to name the question it answers. */
export function encodeCodexQuestionOptionId(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

export function decodeCodexQuestionOptionId(
  optionId: string
): { questionId: string; answer: string } | null {
  const separator = optionId.indexOf(':')
  if (separator <= 0) {
    return null
  }
  try {
    return {
      questionId: decodeURIComponent(optionId.slice(0, separator)),
      answer: decodeURIComponent(optionId.slice(separator + 1))
    }
  } catch {
    return null
  }
}

/**
 * Records one answer and returns the reply payload once the request is fully
 * answered. A multi-question user-input request stays pending until every
 * question has an answer, because Codex takes one reply for all of them.
 */
export function applyCodexPromptAnswer(
  prompt: CodexPendingPrompt,
  optionId: string
): Record<string, unknown> | null {
  if (prompt.method !== CODEX_USER_INPUT_METHOD) {
    if (!isCodexApprovalDecision(optionId)) {
      throw new Error(`${optionId} is not a Codex approval decision`)
    }
    return { decision: optionId }
  }
  const mapped = prompt.optionAnswers.get(optionId)
  const decoded = mapped ?? decodeCodexQuestionOptionId(optionId)
  const questionId =
    (decoded?.questionId
      ? (prompt.questionIdAliases.get(decoded.questionId) ?? decoded.questionId)
      : null) ?? (prompt.questionIds.length === 1 ? prompt.questionIds[0] : null)
  const answer = decoded?.answer ?? optionId
  if (!questionId || !prompt.questionIds.includes(questionId)) {
    throw new Error(`${optionId} does not name a question on Codex item ${prompt.codexItemId}`)
  }
  if (Buffer.byteLength(answer, 'utf8') > CODEX_PROMPT_MAX_ANSWER_BYTES) {
    throw new Error('codex prompt answer exceeds bounded registry state')
  }
  prompt.answers.set(questionId, answer)
  if (prompt.questionIds.some((id) => !prompt.answers.has(id))) {
    return null
  }
  const answers: Record<string, { answers: string[] }> = {}
  for (const id of prompt.questionIds) {
    const answer = prompt.answers.get(id)
    if (answer === undefined) {
      return null
    }
    answers[id] = { answers: [answer] }
  }
  return { answers }
}

/** Throws for a prompt Codex is no longer waiting on, which the wire reports as
 *  "recorded but not confirmed" rather than as a delivered answer. */
export function answerCodexPrompt(
  registry: CodexPromptRegistry,
  connection: Pick<CodexAppServerConnection, 'respond'>,
  claim: CodexPromptClaim,
  optionId: string
): void {
  if (!registry.ownsClaim(claim)) {
    throw new Error(`codex app-server is no longer waiting on ${claim.itemId}`)
  }
  const prompt = claim.prompt
  const reply = applyCodexPromptAnswer(prompt, optionId)
  if (reply === null) {
    registry.releaseClaim(claim)
    return
  }
  // Forget first: a second answer must find nothing rather than reply twice.
  registry.forget(prompt)
  connection.respond(prompt.requestId, reply)
}
