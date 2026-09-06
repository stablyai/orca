import type { CodexAppServerConnection } from './codex-app-server-connection'
import {
  CODEX_PROMPT_MAX_ANSWER_BYTES,
  MAX_CODEX_PROMPT_JOURNAL_BINDINGS,
  MAX_CODEX_PROMPT_REGISTRY_BYTES,
  MAX_CODEX_PROMPT_REGISTRY_ENTRIES,
  codexJournalPromptIdPart,
  readQuestionIds,
  readQuestionOptionAnswers
} from './codex-prompt-registry-bounds'
export {
  codexJournalPromptIdPart,
  MAX_CODEX_PROMPT_REGISTRY_ENTRIES,
  MAX_CODEX_PROMPT_JOURNAL_BINDINGS,
  MAX_CODEX_PROMPT_REGISTRY_BYTES,
  encodeCodexJournalQuestionOptionId
} from './codex-prompt-registry-bounds'

// Codex asks for approvals and tool input by sending JSON-RPC REQUESTS back to
// Orca, and the turn blocks until each one is answered. The journal answers them
// much later, through a durable item id, so this module holds the live request
// ids and turns a chosen option back into the reply payload Codex expects.

export const CODEX_COMMAND_APPROVAL_METHOD = 'item/commandExecution/requestApproval'
export const CODEX_FILE_CHANGE_APPROVAL_METHOD = 'item/fileChange/requestApproval'
export const CODEX_USER_INPUT_METHOD = 'item/tool/requestUserInput'

/** The decisions Codex accepts for both approval requests. Anything else is a
 *  client-supplied option id that never came from a Codex prompt. */
export const CODEX_APPROVAL_DECISIONS = ['accept', 'acceptForSession', 'decline', 'cancel'] as const
export type CodexApprovalDecision = (typeof CODEX_APPROVAL_DECISIONS)[number]

export type CodexPendingPrompt = {
  requestId: number | string
  method: string
  threadId: string
  turnId: string | null
  codexItemId: string
  /** What addresses this prompt. One tool item can ask more than once — a shell
   *  bridge re-asks per command under the same `itemId` — so the request's own
   *  `approvalId` is the identity whenever Codex sends one. */
  promptKey: string
  /** One entry per question for a user-input request; empty for an approval. */
  questionIds: readonly string[]
  /** Journal-facing ids can be bounded; replies still need Codex's exact ids. */
  questionIdAliases: ReadonlyMap<string, string>
  optionAnswers: ReadonlyMap<string, { questionId: string; answer: string }>
  answers: Map<string, string>
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

function readString(params: unknown, key: string): string | null {
  if (typeof params !== 'object' || params === null) {
    return null
  }
  const value = (params as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function isCodexPromptMethod(method: string): boolean {
  return (
    method === CODEX_COMMAND_APPROVAL_METHOD ||
    method === CODEX_FILE_CHANGE_APPROVAL_METHOD ||
    method === CODEX_USER_INPUT_METHOD
  )
}

/**
 * Live Codex prompt requests for one session, addressable by the journal item
 * id the client will eventually answer with. The binding is registered by the
 * translation module, because only it knows which journal item a Codex item
 * became.
 */
export class CodexPromptRegistry {
  private readonly byAddress = new Map<string, CodexPendingPrompt>()
  /** Journal item id to thread-scoped prompt address. */
  private readonly journalItemIds = new Map<string, string>()
  /** Bound prompts survive LRU eviction of the lookup window until answered. */
  private readonly boundPrompts = new Map<string, CodexPendingPrompt>()

  get sizes(): { prompts: number; journalBindings: number } {
    return { prompts: this.byAddress.size, journalBindings: this.journalItemIds.size }
  }

  get bytes(): number {
    return this.retainedPromptBytes()
  }

  private promptBytes(prompt: CodexPendingPrompt): number {
    let bytes = 0
    for (const value of [
      prompt.threadId,
      prompt.turnId ?? '',
      prompt.codexItemId,
      prompt.promptKey
    ]) {
      bytes += Buffer.byteLength(value, 'utf8')
    }
    for (const id of prompt.questionIds) {
      bytes += Buffer.byteLength(id, 'utf8')
    }
    for (const entry of prompt.optionAnswers.values()) {
      bytes += Buffer.byteLength(entry.questionId, 'utf8') + Buffer.byteLength(entry.answer, 'utf8')
    }
    for (const value of prompt.answers.values()) {
      bytes += Buffer.byteLength(value, 'utf8')
    }
    return bytes
  }

  private retainedPromptBytes(): number {
    const prompts = new Set([...this.byAddress.values(), ...this.boundPrompts.values()])
    return [...prompts].reduce((total, prompt) => total + this.promptBytes(prompt), 0)
  }

  private trim(): void {
    while (this.byAddress.size > MAX_CODEX_PROMPT_REGISTRY_ENTRIES) {
      const oldest = this.byAddress.values().next().value as CodexPendingPrompt | undefined
      if (!oldest) {
        break
      }
      const address = this.address(oldest.threadId, oldest.promptKey)
      this.byAddress.delete(address)
    }
    while (this.journalItemIds.size > MAX_CODEX_PROMPT_JOURNAL_BINDINGS) {
      const oldest = this.journalItemIds.keys().next().value as string | undefined
      if (!oldest) {
        break
      }
      this.journalItemIds.delete(oldest)
      this.boundPrompts.delete(oldest)
    }
  }

  private address(threadId: string, promptKey: string): string {
    return `${encodeURIComponent(threadId)}:${encodeURIComponent(promptKey)}`
  }

  /** Returns null for a request this build does not model, so the caller can
   *  refuse it instead of leaving Codex blocked on an answer forever. */
  register(request: {
    id: number | string
    method: string
    params: unknown
  }): CodexPendingPrompt | null {
    const codexItemId = readString(request.params, 'itemId')
    const threadId = readString(request.params, 'threadId')
    if (!isCodexPromptMethod(request.method) || !codexItemId || !threadId) {
      return null
    }
    const questionIds =
      request.method === CODEX_USER_INPUT_METHOD ? readQuestionIds(request.params) : []
    if (questionIds === null) {
      return null
    }
    const optionAnswers =
      request.method === CODEX_USER_INPUT_METHOD
        ? readQuestionOptionAnswers(request.params)
        : new Map<string, { questionId: string; answer: string }>()
    if (optionAnswers === null) {
      return null
    }
    const prompt: CodexPendingPrompt = {
      requestId: request.id,
      method: request.method,
      threadId,
      turnId: readString(request.params, 'turnId'),
      codexItemId,
      promptKey: readString(request.params, 'approvalId') ?? codexItemId,
      questionIds,
      questionIdAliases:
        request.method === CODEX_USER_INPUT_METHOD
          ? new Map(questionIds.map((id) => [codexJournalPromptIdPart(id), id]))
          : new Map(),
      optionAnswers,
      answers: new Map()
    }
    const promptBytes = this.promptBytes(prompt)
    if (promptBytes > MAX_CODEX_PROMPT_REGISTRY_BYTES) {
      return null
    }
    while (
      this.retainedPromptBytes() + promptBytes > MAX_CODEX_PROMPT_REGISTRY_BYTES &&
      this.byAddress.size > 0
    ) {
      const oldest = this.byAddress.values().next().value as CodexPendingPrompt | undefined
      if (!oldest) {
        break
      }
      this.byAddress.delete(this.address(oldest.threadId, oldest.promptKey))
    }
    if (this.retainedPromptBytes() + promptBytes > MAX_CODEX_PROMPT_REGISTRY_BYTES) {
      return null
    }
    const address = this.address(prompt.threadId, prompt.promptKey)
    this.byAddress.delete(address)
    this.byAddress.set(address, prompt)
    this.trim()
    return prompt
  }

  /** Called by the translation module once the prompt has a journal id. */
  bindJournalItemId(journalItemId: string, threadId: string, promptKey: string): void {
    const existing = this.journalItemIds.get(journalItemId)
    if (existing) {
      this.boundPrompts.delete(journalItemId)
    }
    this.journalItemIds.delete(journalItemId)
    const address = this.address(threadId, promptKey)
    const prompt = this.byAddress.get(address)
    if (!prompt) {
      return
    }
    this.journalItemIds.set(journalItemId, address)
    this.boundPrompts.set(journalItemId, prompt)
    this.trim()
  }

  /** Falls back to treating the id as a prompt key, which is what it is before
   *  any binding exists. */
  find(journalItemId: string): CodexPendingPrompt | null {
    const address = this.journalItemIds.get(journalItemId)
    if (address) {
      return this.boundPrompts.get(journalItemId) ?? this.byAddress.get(address) ?? null
    }
    const matches = [...this.byAddress.values()].filter(
      (prompt) => prompt.promptKey === journalItemId
    )
    return matches.length === 1 ? matches[0]! : null
  }

  forget(prompt: CodexPendingPrompt): void {
    const address = this.address(prompt.threadId, prompt.promptKey)
    if (this.byAddress.get(address) === prompt) {
      this.byAddress.delete(address)
    }
    for (const [journalItemId, boundPrompt] of this.boundPrompts) {
      if (boundPrompt === prompt) {
        this.journalItemIds.delete(journalItemId)
        this.boundPrompts.delete(journalItemId)
      }
    }
  }

  clear(): void {
    this.byAddress.clear()
    this.journalItemIds.clear()
    this.boundPrompts.clear()
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
    if (!(CODEX_APPROVAL_DECISIONS as readonly string[]).includes(optionId)) {
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
    answers[id] = { answers: [prompt.answers.get(id) as string] }
  }
  return { answers }
}

/** Throws for a prompt Codex is no longer waiting on, which the wire reports as
 *  "recorded but not confirmed" rather than as a delivered answer. */
export function answerCodexPrompt(
  registry: CodexPromptRegistry,
  connection: Pick<CodexAppServerConnection, 'respond'>,
  itemId: string,
  optionId: string
): void {
  const prompt = registry.find(itemId)
  if (!prompt) {
    throw new Error(`codex app-server is no longer waiting on ${itemId}`)
  }
  const reply = applyCodexPromptAnswer(prompt, optionId)
  if (reply === null) {
    return
  }
  // Forget first: a second answer must find nothing rather than reply twice.
  registry.forget(prompt)
  connection.respond(prompt.requestId, reply)
}
