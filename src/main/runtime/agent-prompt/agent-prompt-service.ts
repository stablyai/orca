import { parseAgentPromptId } from '../../../shared/agent-prompt/pending-agent-prompt'
import type {
  AgentPromptRespondResult,
  PendingAgentPrompt
} from '../../../shared/rpc-contract/agent-prompt-params'

export type AgentPromptDirectory = {
  list(): readonly PendingAgentPrompt[]
  /** The chat session or terminal pty is still here, even when this prompt id is not. */
  targetExists(promptId: string): boolean
  apply(
    prompt: PendingAgentPrompt,
    optionId: string,
    clientOperationId: string,
    callerKey: string
  ): Promise<AgentPromptRespondResult>
}

type LedgerEntry = {
  promptId: string
  optionId: string
  result: AgentPromptRespondResult
}

const unavailable: AgentPromptRespondResult = { ok: false, reason: 'unavailable' }

/** One answer per clientOperationId. A repeat with a different prompt or option is rejected. */
export class AgentPromptService {
  private readonly ledger = new Map<string, Promise<LedgerEntry>>()

  constructor(private readonly directory: AgentPromptDirectory) {}

  listPending(): { prompts: PendingAgentPrompt[] } {
    return { prompts: [...this.directory.list()] }
  }

  async respond(input: {
    promptId: string
    optionId: string
    clientOperationId: string
    callerKey: string
  }): Promise<AgentPromptRespondResult> {
    const existing = this.ledger.get(input.clientOperationId)
    if (existing) {
      const entry = await existing
      return entry.promptId === input.promptId && entry.optionId === input.optionId
        ? entry.result
        : { ok: false, reason: 'rejected' }
    }
    const pending = this.settle(input)
    this.ledger.set(input.clientOperationId, pending)
    return (await pending).result
  }

  private settle(input: {
    promptId: string
    optionId: string
    clientOperationId: string
    callerKey: string
  }): Promise<LedgerEntry> {
    return this.perform(input)
      .then((result) => ({ promptId: input.promptId, optionId: input.optionId, result }))
      .catch(() => ({ promptId: input.promptId, optionId: input.optionId, result: unavailable }))
  }

  private async perform(input: {
    promptId: string
    optionId: string
    clientOperationId: string
    callerKey: string
  }): Promise<AgentPromptRespondResult> {
    if (!parseAgentPromptId(input.promptId)) {
      return { ok: false, reason: 'not_found' }
    }
    const current = this.directory.list().find((prompt) => prompt.promptId === input.promptId)
    if (!current) {
      return {
        ok: false,
        reason: this.directory.targetExists(input.promptId) ? 'stale' : 'not_found'
      }
    }
    if (!current.options.some((option) => option.optionId === input.optionId)) {
      return { ok: false, reason: 'rejected' }
    }
    return this.directory.apply(current, input.optionId, input.clientOperationId, input.callerKey)
  }
}
