import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { codexPromptIdentity, codexQuestionItems } from './codex-structured-prompt-items'
import { digestPayload } from '../native-chat/agent-session-journal/journal-payload-bounds'
import { MAX_CODEX_PENDING_PROMPTS } from './codex-structured-journal-limits'
import { randomUUID } from 'node:crypto'
import {
  MAX_CODEX_PROMPT_JOURNAL_BINDINGS,
  MAX_CODEX_PROMPT_REGISTRY_BYTES,
  MAX_CODEX_PROMPT_REGISTRY_ENTRIES,
  codexPromptMatchesTurn,
  codexPromptRegistryEntryBytes,
  codexPromptTurnIdentity
} from './codex-prompt-registry-bounds'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  readCodexPendingPrompt,
  type CodexPendingPrompt
} from './codex-prompt-request'
export {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  CODEX_USER_INPUT_METHOD,
  CODEX_MCP_ELICITATION_METHOD,
  isCodexPromptMethod,
  type CodexPendingPrompt
} from './codex-prompt-request'

export type CodexAbandonedCommand = { threadId: string; itemId: string }
const NO_ABANDONED_COMMANDS: readonly CodexAbandonedCommand[] = []

export type CodexPromptClaim = {
  readonly itemId: string
  readonly prompt: CodexPendingPrompt
  answer?: string
}

// Callback ownership is session-local and cannot be reconstructed from the journal.
export class CodexPromptRegistry {
  private readonly registryId = randomUUID()
  private readonly byAddress = new Map<string, CodexPendingPrompt>()
  private readonly journalItemIds = new Map<string, string>()
  private readonly boundPrompts = new Map<string, CodexPendingPrompt>()
  private readonly claims = new Map<CodexPendingPrompt, CodexPromptClaim>()
  private abandonedCommands: CodexAbandonedCommand[] = []

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
    const admission = this.admit(request)
    return admission.kind === 'admitted' ? admission.prompt : null
  }

  admit(request: {
    id: number | string
    method: string
    params: unknown
  }):
    | { kind: 'admitted'; prompt: CodexPendingPrompt; replay: boolean }
    | { kind: 'unsupported' | 'refused' } {
    const prompt = readCodexPendingPrompt(request, this.registryId)
    if (!prompt) {
      return { kind: 'unsupported' }
    }
    const rows =
      prompt.method === CODEX_USER_INPUT_METHOD
        ? codexQuestionItems({
            threadId: prompt.threadId,
            promptKey: prompt.promptKey,
            params: request.params
          })
        : [{ identity: codexPromptIdentity(prompt), questionId: null }]
    prompt.journalRows = new Map(
      rows.map((row): [string, string | null] => [
        agentJournalItemKey(row.identity),
        row.questionId
      ])
    )
    prompt.requestFingerprint = digestPayload(JSON.stringify(request.params))
    if (
      rows.length === 0 ||
      prompt.journalRows.size !== new Set(rows.map((row) => row.questionId)).size ||
      (prompt.method === CODEX_USER_INPUT_METHOD &&
        (rows.length !== prompt.questionIds.length ||
          new Set(prompt.questionIds).size !== prompt.journalRows.size ||
          rows.some(
            (row) => row.questionId === null || !prompt.questionIds.includes(row.questionId)
          )))
    ) {
      return { kind: 'refused' }
    }
    const retained = this.retainedPrompts()
    const address = this.address(prompt.threadId, prompt.promptKey)
    for (const prior of retained) {
      if (prior.threadId === prompt.threadId && prior.requestId === prompt.requestId) {
        return prior.method === prompt.method &&
          prior.requestFingerprint === prompt.requestFingerprint
          ? { kind: 'admitted', prompt: prior, replay: true }
          : { kind: 'refused' }
      }
      if (
        this.address(prior.threadId, prior.promptKey) === address ||
        [...prompt.journalRows.keys()].some((id) => prior.journalRows.has(id))
      ) {
        return { kind: 'refused' }
      }
    }
    const reserved = [...retained].reduce(
      (total, prior) =>
        total +
        [...prior.journalRows.values()].filter((id) => id === null || !prior.answers.has(id))
          .length,
      0
    )
    if (
      retained.size + 1 > MAX_CODEX_PROMPT_REGISTRY_ENTRIES ||
      reserved + prompt.journalRows.size >
        Math.min(MAX_CODEX_PENDING_PROMPTS, MAX_CODEX_PROMPT_JOURNAL_BINDINGS) ||
      this.retainedPromptBytes() + codexPromptRegistryEntryBytes(prompt) >
        MAX_CODEX_PROMPT_REGISTRY_BYTES
    ) {
      return { kind: 'refused' }
    }
    // Reserve the complete obligation before publication can reenter delivery.
    this.byAddress.set(address, prompt)
    return { kind: 'admitted', prompt, replay: false }
  }

  bindJournalItemId(
    journalItemId: string,
    threadId: string,
    promptKey: string,
    turnId?: string | null
  ): void {
    const address = this.address(threadId, promptKey)
    const prompt = this.byAddress.get(address)
    if (!prompt || !prompt.journalRows.has(journalItemId)) {
      return
    }
    const previous = this.boundPrompts.get(journalItemId)
    if (previous && previous !== prompt) {
      throw new Error('A live prompt binding cannot be replaced.')
    }
    if (prompt.turnId === null && prompt.turnIdDigest === undefined && turnId) {
      Object.assign(prompt, codexPromptTurnIdentity(turnId))
    }
    this.journalItemIds.set(journalItemId, address)
    this.boundPrompts.set(journalItemId, prompt)
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
      [...this.byAddress.values(), ...this.boundPrompts.values(), ...this.claims.keys()].filter(
        (prompt) => prompt.threadId === threadId && codexPromptMatchesTurn(prompt, turnId)
      )
    )
    for (const prompt of prompts) {
      this.forget(prompt)
      // Only whole-command approvals imply no execution; approvalId targets a subcommand.
      if (
        prompt.method === CODEX_COMMAND_APPROVAL_METHOD &&
        prompt.promptKey === prompt.codexItemId
      ) {
        this.abandonedCommands.push({ threadId: prompt.threadId, itemId: prompt.codexItemId })
      }
    }
  }

  takeAbandonedCommands(): readonly CodexAbandonedCommand[] {
    if (this.abandonedCommands.length === 0) {
      return NO_ABANDONED_COMMANDS
    }
    const taken = this.abandonedCommands
    this.abandonedCommands = []
    return taken
  }

  clear(): void {
    this.byAddress.clear()
    this.journalItemIds.clear()
    this.boundPrompts.clear()
    this.claims.clear()
    this.abandonedCommands = []
  }

  private address(threadId: string, promptKey: string): string {
    return `${encodeURIComponent(threadId)}:${encodeURIComponent(promptKey)}`
  }

  private kind(prompt: CodexPendingPrompt): 'approval' | 'question' {
    return prompt.method === CODEX_USER_INPUT_METHOD ? 'question' : 'approval'
  }

  reserveAnswer(claim: CodexPromptClaim, answer: string): boolean {
    if (
      !this.ownsClaim(claim) ||
      this.retainedPromptBytes() + Buffer.byteLength(answer, 'utf8') >
        MAX_CODEX_PROMPT_REGISTRY_BYTES
    ) {
      return false
    }
    // Count answers held across the asynchronous commit, including other requests' claims.
    claim.answer = answer
    return true
  }

  completePartialAnswer(claim: CodexPromptClaim): void {
    if (this.boundPrompts.get(claim.itemId) === claim.prompt) {
      this.boundPrompts.delete(claim.itemId)
      this.journalItemIds.delete(claim.itemId)
    }
    this.releaseClaim(claim)
  }

  private retainedPrompts(): Set<CodexPendingPrompt> {
    return new Set([
      ...this.byAddress.values(),
      ...this.boundPrompts.values(),
      ...this.claims.keys()
    ])
  }

  private retainedPromptBytes(): number {
    const prompts = this.retainedPrompts()
    const claimedBytes = [...this.claims.values()].reduce(
      (total, claim) => total + Buffer.byteLength(claim.answer ?? '', 'utf8'),
      0
    )
    return (
      claimedBytes +
      [...prompts].reduce((total, prompt) => total + codexPromptRegistryEntryBytes(prompt), 0)
    )
  }
}
