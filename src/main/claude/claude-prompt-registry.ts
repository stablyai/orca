import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentJournalApprovalMatchedAskRule,
  AgentJournalApprovalSubject
} from '../../shared/agent-session-journal-types'

/** Settles the SDK's `canUseTool` promise; `null` writes no provider response. */
export type ClaudePromptSettle = (response: PermissionResult | null) => void

export type ClaudePromptPresentation = {
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  matchedAskRule?: AgentJournalApprovalMatchedAskRule
  subject?: AgentJournalApprovalSubject
}

export type ClaudePendingPrompt = ClaudePromptPresentation & {
  requestId: string
  promptKey: string
  toolUseId: string
  toolName: string
  kind: 'approval' | 'question'
  input: Record<string, unknown>
  suggestions: PermissionUpdate[]
  questionIds: readonly string[]
  answers: Map<string, string | readonly string[]>
  settle: ClaudePromptSettle
  turnId?: string | null
  /** The subagent the provider says asked; absent when the session's own agent did. */
  agentId?: string
}

export type ClaudePromptRegistration = ClaudePromptPresentation & {
  requestId: string
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  suggestions: PermissionUpdate[]
  settle: ClaudePromptSettle
  turnId?: string | null
  agentId?: string
}

type PromptBinding = {
  address: string
  questionId?: string
  turnId: string | null
}

export type ClaudePromptClaim = {
  readonly itemId: string
  readonly found: { prompt: ClaudePendingPrompt; questionId?: string }
}

type ClaudePromptCancellationObservation = {
  promise: Promise<void>
  resolve: () => void
}

export function isClaudePromptRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readClaudePromptString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export function claudePromptQuestions(input: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(input.questions) ? input.questions.filter(isClaudePromptRecord) : []
}

function questionId(question: Record<string, unknown>, index: number): string {
  return (
    readClaudePromptString(question.question) ??
    readClaudePromptString(question.header) ??
    `question-${index + 1}`
  )
}

/** The subagent that raised a request: the one the provider names, or, from a CLI that names none,
 *  the child that owns the tool call it gates. Null when the session's own agent asked. */
export function claudePromptAskingChild(
  prompt: Pick<ClaudePendingPrompt, 'agentId' | 'toolUseId'>,
  ownerOf: ((toolUseId: string) => string | null) | undefined
): string | null {
  return prompt.agentId ?? ownerOf?.(prompt.toolUseId) ?? null
}

/** Session-local callback ownership; none of this state is reconstructed from the transcript. */
export class ClaudePromptRegistry {
  private readonly prompts = new Map<string, ClaudePendingPrompt>()
  private readonly journalBindings = new Map<string, PromptBinding>()
  private readonly claims = new Map<ClaudePendingPrompt, ClaudePromptClaim>()
  private readonly cancellationObservations = new WeakMap<
    ClaudePendingPrompt,
    ClaudePromptCancellationObservation
  >()

  register(registration: ClaudePromptRegistration): ClaudePendingPrompt | null {
    const toolUseId = readClaudePromptString(registration.toolUseId)
    const toolName = readClaudePromptString(registration.toolName)
    const input = isClaudePromptRecord(registration.input) ? registration.input : null
    const agentId = readClaudePromptString(registration.agentId)
    if (!toolUseId || !toolName || !input) {
      return null
    }
    const questions = toolName === 'AskUserQuestion' ? claudePromptQuestions(input) : []
    const prompt: ClaudePendingPrompt = {
      requestId: registration.requestId,
      promptKey: registration.requestId,
      toolUseId,
      toolName,
      kind: questions.length > 0 ? 'question' : 'approval',
      input,
      suggestions: Array.isArray(registration.suggestions) ? registration.suggestions : [],
      ...(registration.title ? { title: registration.title } : {}),
      ...(registration.displayName ? { displayName: registration.displayName } : {}),
      ...(registration.description ? { description: registration.description } : {}),
      ...(registration.decisionReason ? { decisionReason: registration.decisionReason } : {}),
      ...(registration.blockedPath ? { blockedPath: registration.blockedPath } : {}),
      ...(registration.matchedAskRule ? { matchedAskRule: registration.matchedAskRule } : {}),
      ...(registration.subject ? { subject: registration.subject } : {}),
      questionIds: questions.map(questionId),
      answers: new Map(),
      settle: registration.settle,
      turnId: registration.turnId ?? null,
      ...(agentId ? { agentId } : {})
    }
    this.prompts.set(prompt.promptKey, prompt)
    return prompt
  }

  /** Every request the provider is still blocked on. */
  pending(): IterableIterator<ClaudePendingPrompt> {
    return this.prompts.values()
  }

  /** True only if the prompt was still pending; lets abort and answer settle once. */
  forgetIfPending(prompt: ClaudePendingPrompt): boolean {
    if (!this.prompts.has(prompt.promptKey)) {
      return false
    }
    const observation = this.cancellationObservations.get(prompt)
    this.forget(prompt)
    observation?.resolve()
    return true
  }

  bindJournalItemId(
    journalItemId: string,
    promptKey: string,
    questionIdForItem?: string,
    turnId: string | null = null
  ): void {
    const prompt = this.prompts.get(promptKey)
    this.journalBindings.set(journalItemId, {
      address: promptKey,
      ...(questionIdForItem ? { questionId: questionIdForItem } : {}),
      turnId: turnId ?? prompt?.turnId ?? null
    })
  }

  find(itemId: string): { prompt: ClaudePendingPrompt; questionId?: string } | null {
    const binding = this.journalBindings.get(itemId)
    const prompt = this.prompts.get(binding?.address ?? itemId)
    return prompt
      ? { prompt, ...(binding?.questionId ? { questionId: binding.questionId } : {}) }
      : null
  }

  claim(itemId: string, kind?: 'approval' | 'question'): ClaudePromptClaim | null {
    const found = this.find(itemId)
    if (!found || this.claims.has(found.prompt) || (kind && found.prompt.kind !== kind)) {
      return null
    }
    const claim = { itemId, found }
    this.claims.set(found.prompt, claim)
    return claim
  }

  claimBound(itemId: string, turnId: string): ClaudePromptClaim | null {
    const binding = this.journalBindings.get(itemId)
    const prompt = binding ? this.prompts.get(binding.address) : undefined
    if (!binding || !prompt || binding.turnId !== turnId || this.claims.has(prompt)) {
      return null
    }
    const found = { prompt, ...(binding.questionId ? { questionId: binding.questionId } : {}) }
    const claim = { itemId, found }
    this.claims.set(prompt, claim)
    return claim
  }

  ownsClaim(claim: ClaudePromptClaim): boolean {
    return (
      this.claims.get(claim.found.prompt) === claim &&
      this.find(claim.itemId)?.prompt === claim.found.prompt
    )
  }

  ownsBoundClaim(claim: ClaudePromptClaim, itemId: string, turnId: string): boolean {
    const binding = this.journalBindings.get(itemId)
    return (
      claim.itemId === itemId &&
      this.claims.get(claim.found.prompt) === claim &&
      binding?.address === claim.found.prompt.promptKey &&
      binding.turnId === turnId &&
      this.prompts.get(binding.address) === claim.found.prompt
    )
  }

  releaseClaim(claim: ClaudePromptClaim): void {
    if (this.claims.get(claim.found.prompt) === claim) {
      this.claims.delete(claim.found.prompt)
    }
  }

  observeCancellation(claim: ClaudePromptClaim): Promise<void> | null {
    if (!this.ownsClaim(claim)) {
      return null
    }
    let observation = this.cancellationObservations.get(claim.found.prompt)
    if (!observation) {
      let resolve = (): void => {}
      const promise = new Promise<void>((settled) => {
        resolve = settled
      })
      observation = { promise, resolve }
      this.cancellationObservations.set(claim.found.prompt, observation)
    }
    return observation.promise
  }

  cancel(requestId: string): ClaudePendingPrompt | null {
    const prompt = this.prompts.get(requestId) ?? null
    if (prompt) {
      this.forget(prompt)
    }
    return prompt
  }

  forget(prompt: ClaudePendingPrompt): void {
    this.claims.delete(prompt)
    this.prompts.delete(prompt.promptKey)
    for (const [itemId, binding] of this.journalBindings) {
      if (binding.address === prompt.promptKey) {
        this.journalBindings.delete(itemId)
      }
    }
  }

  clear(): ClaudePendingPrompt[] {
    const pending = [...this.prompts.values()]
    this.prompts.clear()
    this.journalBindings.clear()
    this.claims.clear()
    for (const prompt of pending) {
      this.cancellationObservations.get(prompt)?.resolve()
    }
    return pending
  }
}
