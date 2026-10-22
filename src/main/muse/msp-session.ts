// One live `muse serve` child and the MSP session Orca drives on it: turn
// tracking, pending approval and question callbacks, and current options.

import type { MspClient } from './msp-client'
import { mintMspCommandId } from './msp-client'
import type {
  MspApprovalRequest,
  MspItem,
  MspItemDeltaEvent,
  MspItemEvent,
  MspTokenUsageEvent,
  MspTurnEvent,
  MspUserInputRequest
} from './msp-protocol'
import type { MspDispatchInput } from './msp-dispatch-input'
import { mspTurnParts } from './msp-dispatch-input'

export type MspPendingApproval = {
  request: MspApprovalRequest
  resolve: (choiceId: string, feedback?: string) => void
  reject: (error: Error) => void
}

export type MspPendingQuestion = {
  request: MspUserInputRequest
  resolve: (
    answers: { questionId: string; selectedLabel?: string; selectedLabels?: string[] }[]
  ) => void
  reject: (error: Error) => void
}

export type MspSessionEvents = {
  onItemStarted?: (event: MspItemEvent) => void
  onItemDelta?: (event: MspItemDeltaEvent) => void
  onItemUpdated?: (event: MspItemEvent) => void
  onItemCompleted?: (event: MspItemEvent) => void
  onTurnStarted?: (event: MspTurnEvent) => void
  onTurnCompleted?: (event: MspTurnEvent) => void
  onTokenUsage?: (event: MspTokenUsageEvent) => void
  onStatusChanged?: (status: string, sessionId: string) => void
}

export class MspStructuredSession {
  private turnId: string | null = null
  private turnCount = 0
  private ended = false
  private readonly approvals = new Map<string, MspPendingApproval>()
  private readonly questions = new Map<string, MspPendingQuestion>()
  onApproval: ((request: MspApprovalRequest) => void) | null = null
  onQuestion: ((request: MspUserInputRequest) => void) | null = null

  modelId: string | null
  reasoningEffort: string | null = null
  permissionProfile: string | null = null

  constructor(
    readonly sessionId: string,
    readonly client: MspClient,
    readonly events: MspSessionEvents = {},
    options: { modelId?: string | null } = {}
  ) {
    this.modelId = options.modelId ?? null
    client.setNotificationHandler((method, params) => this.routeNotification(method, params))
    client.setRequestHandler(async (method, params) => this.routeRequest(method, params))
  }

  get openTurnId(): string | null {
    return this.turnId
  }

  get running(): boolean {
    return this.turnId !== null
  }

  get closed(): boolean {
    return this.ended
  }

  markEnded(): void {
    this.ended = true
    const gone = new Error('the Muse session ended')
    for (const pending of this.approvals.values()) {
      pending.reject(gone)
    }
    this.approvals.clear()
    for (const pending of this.questions.values()) {
      pending.reject(gone)
    }
    this.questions.clear()
  }

  private routeNotification(method: string, params: unknown): void {
    if (this.ended || typeof params !== 'object' || params === null) {
      return
    }
    const event = params as Record<string, unknown>
    if (event.sessionId !== this.sessionId) {
      return
    }
    switch (method) {
      case 'item/started':
        this.events.onItemStarted?.(event as unknown as MspItemEvent)
        break
      case 'item/delta':
        this.events.onItemDelta?.(event as unknown as MspItemDeltaEvent)
        break
      case 'item/updated':
        this.events.onItemUpdated?.(event as unknown as MspItemEvent)
        break
      case 'item/completed':
        this.events.onItemCompleted?.(event as unknown as MspItemEvent)
        break
      case 'turn/started':
        this.turnId = typeof event.turnId === 'string' ? event.turnId : this.turnId
        this.events.onTurnStarted?.(event as unknown as MspTurnEvent)
        break
      case 'turn/completed':
        this.turnId = null
        this.turnCount += 1
        this.events.onTurnCompleted?.(event as unknown as MspTurnEvent)
        break
      case 'session/tokenUsage':
        this.events.onTokenUsage?.(event as unknown as MspTokenUsageEvent)
        break
      case 'session/statusChanged':
        if (typeof event.status === 'string') {
          this.events.onStatusChanged?.(event.status, this.sessionId)
        }
        break
      default:
        break
    }
  }

  private routeRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'approval/request': {
        const request = params as unknown as MspApprovalRequest
        try {
          this.onApproval?.(request)
        } catch {
          // Journaling never blocks the provider request.
        }
        return new Promise((resolve, reject) => {
          this.approvals.set(request.approvalId, {
            request,
            resolve: (choiceId, feedback) =>
              resolve({ choiceId, ...(feedback ? { feedback } : {}) }),
            reject
          })
        })
      }
      case 'userInput/request': {
        const request = params as unknown as MspUserInputRequest
        try {
          this.onQuestion?.(request)
        } catch {
          // Journaling never blocks the provider request.
        }
        return new Promise((resolve, reject) => {
          this.questions.set(request.userInputId, {
            request,
            resolve: (answers) => resolve({ answers }),
            reject
          })
        })
      }
      default:
        return Promise.reject(new Error(`unsupported MSP server request ${method}`))
    }
  }

  takeApproval(approvalId: string): MspPendingApproval | undefined {
    const pending = this.approvals.get(approvalId)
    if (pending) {
      this.approvals.delete(approvalId)
    }
    return pending
  }

  takeQuestion(userInputId: string): MspPendingQuestion | undefined {
    const pending = this.questions.get(userInputId)
    if (pending) {
      this.questions.delete(userInputId)
    }
    return pending
  }

  pendingApprovalCount(): number {
    return this.approvals.size
  }

  pendingQuestionCount(): number {
    return this.questions.size
  }

  async startTurn(input: MspDispatchInput, options: { steer?: boolean } = {}): Promise<string> {
    const parts = await mspTurnParts(input)
    const result = await this.client.request<{ turnId: string }>('turn/start', {
      commandId: mintMspCommandId(),
      sessionId: this.sessionId,
      input: parts,
      ifBusy: options.steer === false ? 'queue' : 'steer'
    })
    this.turnId = result.turnId
    return result.turnId
  }

  async interruptTurn(turnId?: string): Promise<void> {
    await this.client.request('turn/interrupt', {
      commandId: mintMspCommandId(),
      sessionId: this.sessionId,
      ...(turnId ? { turnId } : {})
    })
  }

  async setModel(model: string): Promise<void> {
    await this.client.request('session/setModel', {
      commandId: mintMspCommandId(),
      sessionId: this.sessionId,
      model
    })
    this.modelId = model
  }

  async setReasoningEffort(effort: string): Promise<void> {
    await this.client.request('session/setReasoningEffort', {
      commandId: mintMspCommandId(),
      sessionId: this.sessionId,
      reasoningEffort: effort
    })
    this.reasoningEffort = effort
  }

  async setApprovalMode(mode: string): Promise<void> {
    await this.client.request('session/setApprovalMode', {
      commandId: mintMspCommandId(),
      sessionId: this.sessionId,
      mode
    })
  }

  async decideApproval(
    approvalId: string,
    requirementId: string,
    choiceId: string,
    feedback?: string
  ): Promise<void> {
    const pending = this.takeApproval(approvalId)
    pending?.resolve(choiceId, feedback)
    await this.client.request('approval/decide', {
      commandId: mintMspCommandId(),
      sessionId: this.sessionId,
      approvalId,
      requirementId,
      choiceId,
      ...(feedback ? { feedback } : {})
    })
  }

  async answerQuestions(
    userInputId: string,
    answers: { questionId: string; selectedLabel?: string; selectedLabels?: string[] }[]
  ): Promise<void> {
    const pending = this.takeQuestion(userInputId)
    pending?.resolve(answers)
    await this.client.request('userInput/answer', {
      commandId: mintMspCommandId(),
      sessionId: this.sessionId,
      userInputId,
      answers
    })
  }

  async cancelQuestions(userInputId: string): Promise<void> {
    const pending = this.takeQuestion(userInputId)
    pending?.reject(new Error('the person dismissed the question'))
    await this.client
      .request('userInput/cancel', {
        commandId: mintMspCommandId(),
        sessionId: this.sessionId,
        userInputId
      })
      .catch(() => undefined)
  }

  async readItemOutput(itemId: string, maxBytes = 8192): Promise<string | null> {
    try {
      const result = await this.client.request<{ output?: string; truncated?: boolean }>(
        'item/readOutput',
        { sessionId: this.sessionId, itemId, maxBytes }
      )
      return result.output ?? null
    } catch {
      return null
    }
  }
}

export function mspItemText(item: MspItem): string {
  return item.displayText ?? item.text ?? ''
}
