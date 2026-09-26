import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
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

/** One answer, checked against the prompt but not yet recorded on it. */
export type CodexPreparedAnswer =
  | { kind: 'decision'; decision: CodexApprovalDecision }
  | { kind: 'answer'; questionId: string; answer: string }

/** Validates a client's choice against the prompt without recording it, so an answer Codex
 *  cannot take is refused before the journal commits it. */
export function prepareCodexPromptAnswer(
  prompt: CodexPendingPrompt,
  response: AgentSessionPromptResponse
): CodexPreparedAnswer {
  if (prompt.method !== CODEX_USER_INPUT_METHOD) {
    if (response.kind !== 'option' || !isCodexApprovalDecision(response.optionId)) {
      throw new Error(`Codex item ${prompt.codexItemId} takes an approval decision`)
    }
    return { kind: 'decision', decision: response.optionId }
  }
  // Each Codex question is its own journal item, so an answer names exactly one question.
  const entry =
    response.kind === 'answers' && response.answers.length === 1 ? response.answers[0] : null
  if (!entry) {
    throw new Error(`Codex item ${prompt.codexItemId} takes one question answer`)
  }
  const optionId = entry.optionIds[0]
  const decoded =
    optionId === undefined
      ? { questionId: entry.questionId, answer: entry.other?.trim() ?? '' }
      : (prompt.optionAnswers.get(optionId) ?? decodeCodexQuestionOptionId(optionId))
  const questionId =
    (decoded?.questionId
      ? (prompt.questionIdAliases.get(decoded.questionId) ?? decoded.questionId)
      : null) ?? (prompt.questionIds.length === 1 ? prompt.questionIds[0] : null)
  const answer = decoded?.answer ?? optionId ?? ''
  if (!questionId || !prompt.questionIds.includes(questionId)) {
    throw new Error(`The answer does not name a question on Codex item ${prompt.codexItemId}`)
  }
  if (Buffer.byteLength(answer, 'utf8') > CODEX_PROMPT_MAX_ANSWER_BYTES) {
    throw new Error('codex prompt answer exceeds bounded registry state')
  }
  return { kind: 'answer', questionId, answer }
}

/**
 * Records one prepared answer and returns the reply payload once the request is fully
 * answered. A multi-question user-input request stays pending until every
 * question has an answer, because Codex takes one reply for all of them.
 */
export function applyCodexPromptAnswer(
  prompt: CodexPendingPrompt,
  prepared: CodexPreparedAnswer
): Record<string, unknown> | null {
  if (prepared.kind === 'decision') {
    return { decision: prepared.decision }
  }
  prompt.answers.set(prepared.questionId, prepared.answer)
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
  prepared: CodexPreparedAnswer
): void {
  if (!registry.ownsClaim(claim)) {
    throw new Error(`codex app-server is no longer waiting on ${claim.itemId}`)
  }
  const prompt = claim.prompt
  const reply = applyCodexPromptAnswer(prompt, prepared)
  if (reply === null) {
    registry.releaseClaim(claim)
    return
  }
  // Forget first: a second answer must find nothing rather than reply twice.
  registry.forget(prompt)
  connection.respond(prompt.requestId, reply)
}
