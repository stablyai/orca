import {
  MAX_CODEX_PROMPT_JOURNAL_BINDINGS,
  MAX_CODEX_PROMPT_REGISTRY_BYTES,
  MAX_CODEX_PROMPT_REGISTRY_ENTRIES,
  codexJournalPromptIdPart,
  codexPromptMatchesTurn,
  codexPromptRegistryEntryBytes,
  codexPromptTurnIdentity,
  readQuestionIds,
  readQuestionOptionAnswers
} from './codex-prompt-registry-bounds'
import { readRecord, readString as readRecordString } from './codex-item-field-readers'

export const CODEX_COMMAND_APPROVAL_METHOD = 'item/commandExecution/requestApproval'
export const CODEX_FILE_CHANGE_APPROVAL_METHOD = 'item/fileChange/requestApproval'
export const CODEX_USER_INPUT_METHOD = 'item/tool/requestUserInput'

export type CodexPendingPrompt = {
  requestId: number | string
  method: string
  threadId: string
  turnId: string | null
  /** Oversized compatibility turn ids stay comparable without escaping the registry byte cap. */
  turnIdDigest?: string
  codexItemId: string
  /** One tool item can ask more than once, so approvalId wins over itemId when present. */
  promptKey: string
  questionIds: readonly string[]
  questionIdAliases: ReadonlyMap<string, string>
  optionAnswers: ReadonlyMap<string, { questionId: string; answer: string }>
  answers: Map<string, string>
}

export type CodexPromptClaim = {
  readonly itemId: string
  readonly prompt: CodexPendingPrompt
}

function readString(params: unknown, key: string): string | null {
  return readRecordString(readRecord(params), key)
}

export function isCodexPromptMethod(method: string): boolean {
  return (
    method === CODEX_COMMAND_APPROVAL_METHOD ||
    method === CODEX_FILE_CHANGE_APPROVAL_METHOD ||
    method === CODEX_USER_INPUT_METHOD
  )
}

/** Session-local callback ownership; none of this state is reconstructed from the journal. */
export class CodexPromptRegistry {
  private readonly byAddress = new Map<string, CodexPendingPrompt>()
  private readonly journalItemIds = new Map<string, string>()
  private readonly boundPrompts = new Map<string, CodexPendingPrompt>()
  private readonly claims = new Map<CodexPendingPrompt, CodexPromptClaim>()

  get sizes(): { prompts: number; journalBindings: number } {
    return { prompts: this.byAddress.size, journalBindings: this.journalItemIds.size }
  }

  get bytes(): number {
    return this.retainedPromptBytes()
  }

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
    const turnId = readString(request.params, 'turnId')
    const turnIdentity = turnId ? codexPromptTurnIdentity(turnId) : { turnId: null }
    if (turnId && turnIdentity.turnId === null) {
      return null
    }
    const prompt: CodexPendingPrompt = {
      requestId: request.id,
      method: request.method,
      threadId,
      ...turnIdentity,
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
    const promptBytes = codexPromptRegistryEntryBytes(prompt)
    if (promptBytes > MAX_CODEX_PROMPT_REGISTRY_BYTES) {
      return null
    }
    while (
      this.retainedPromptBytes() + promptBytes > MAX_CODEX_PROMPT_REGISTRY_BYTES &&
      this.byAddress.size > 0
    ) {
      const oldest = this.byAddress.values().next().value
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

  bindJournalItemId(
    journalItemId: string,
    threadId: string,
    promptKey: string,
    turnId?: string | null
  ): void {
    if (this.journalItemIds.has(journalItemId)) {
      this.boundPrompts.delete(journalItemId)
    }
    this.journalItemIds.delete(journalItemId)
    const address = this.address(threadId, promptKey)
    const prompt = this.byAddress.get(address)
    if (!prompt) {
      return
    }
    if (prompt.turnId === null && prompt.turnIdDigest === undefined && turnId) {
      Object.assign(prompt, codexPromptTurnIdentity(turnId))
    }
    this.journalItemIds.set(journalItemId, address)
    this.boundPrompts.set(journalItemId, prompt)
    this.trim()
  }

  find(journalItemId: string): CodexPendingPrompt | null {
    const address = this.journalItemIds.get(journalItemId)
    if (address) {
      return this.boundPrompts.get(journalItemId) ?? this.byAddress.get(address) ?? null
    }
    const matches = [...this.byAddress.values()].filter(
      (prompt) => prompt.promptKey === journalItemId
    )
    return matches.length === 1 ? (matches[0] ?? null) : null
  }

  claim(journalItemId: string, kind?: 'approval' | 'question'): CodexPromptClaim | null {
    const prompt = this.find(journalItemId)
    if (!prompt || this.claims.has(prompt) || (kind && this.kind(prompt) !== kind)) {
      return null
    }
    const claim = { itemId: journalItemId, prompt }
    this.claims.set(prompt, claim)
    return claim
  }

  claimBound(journalItemId: string): CodexPromptClaim | null {
    const prompt = this.boundPrompts.get(journalItemId)
    if (!prompt || this.claims.has(prompt)) {
      return null
    }
    const claim = { itemId: journalItemId, prompt }
    this.claims.set(prompt, claim)
    return claim
  }

  ownsClaim(claim: CodexPromptClaim): boolean {
    return this.claims.get(claim.prompt) === claim && this.find(claim.itemId) === claim.prompt
  }

  ownsBoundClaim(
    claim: CodexPromptClaim,
    journalItemId: string,
    threadId: string,
    turnId: string
  ): boolean {
    return (
      claim.itemId === journalItemId &&
      this.claims.get(claim.prompt) === claim &&
      this.journalItemIds.get(journalItemId) ===
        this.address(claim.prompt.threadId, claim.prompt.promptKey) &&
      this.boundPrompts.get(journalItemId) === claim.prompt &&
      claim.prompt.threadId === threadId &&
      codexPromptMatchesTurn(claim.prompt, turnId)
    )
  }

  releaseClaim(claim: CodexPromptClaim): void {
    if (this.claims.get(claim.prompt) === claim) {
      this.claims.delete(claim.prompt)
    }
  }

  forget(prompt: CodexPendingPrompt): void {
    this.claims.delete(prompt)
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

  clearTurn(threadId: string, turnId: string): void {
    const prompts = new Set(
      [...this.byAddress.values(), ...this.boundPrompts.values()].filter(
        (prompt) => prompt.threadId === threadId && codexPromptMatchesTurn(prompt, turnId)
      )
    )
    for (const prompt of prompts) {
      this.forget(prompt)
    }
  }

  clear(): void {
    this.byAddress.clear()
    this.journalItemIds.clear()
    this.boundPrompts.clear()
    this.claims.clear()
  }

  private address(threadId: string, promptKey: string): string {
    return `${encodeURIComponent(threadId)}:${encodeURIComponent(promptKey)}`
  }

  private kind(prompt: CodexPendingPrompt): 'approval' | 'question' {
    return prompt.method === CODEX_USER_INPUT_METHOD ? 'question' : 'approval'
  }

  private retainedPromptBytes(): number {
    const prompts = new Set([...this.byAddress.values(), ...this.boundPrompts.values()])
    return [...prompts].reduce((total, prompt) => total + codexPromptRegistryEntryBytes(prompt), 0)
  }

  private trim(): void {
    while (this.byAddress.size > MAX_CODEX_PROMPT_REGISTRY_ENTRIES) {
      const oldest = this.byAddress.values().next().value
      if (!oldest) {
        break
      }
      this.byAddress.delete(this.address(oldest.threadId, oldest.promptKey))
    }
    while (this.journalItemIds.size > MAX_CODEX_PROMPT_JOURNAL_BINDINGS) {
      const oldest = this.journalItemIds.keys().next().value
      if (!oldest) {
        break
      }
      this.journalItemIds.delete(oldest)
      this.boundPrompts.delete(oldest)
    }
  }
}
