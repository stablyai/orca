import type { SessionNotification } from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import type { HarnessConversationDriver } from './driver'
import { providerImageData } from './provider-image-input'

type AcceptSteer = Parameters<NonNullable<HarnessConversationDriver['steer']>>[3]
type PendingSteer = {
  id: string
  originalPromptId: string | null
  accept: AcceptSteer
  resolve: () => void
  reject: (error: Error) => void
}

export class GrokSteerController {
  private currentPromptId: string | null = null
  private pending: PendingSteer | null = null
  private readonly fallbacks = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >()
  private steerSupported = true

  constructor(
    private readonly request: (
      method: string,
      params: Record<string, unknown>
    ) => Promise<{ status?: unknown }>,
    private readonly onUnsupported: () => void = () => undefined
  ) {}

  get supported(): boolean {
    return this.steerSupported
  }

  async steer(
    sessionId: string,
    text: string,
    imagePaths: readonly string[] | undefined,
    clientMessageId: string,
    accept: AcceptSteer
  ): Promise<void> {
    if (this.pending) {
      throw new Error('conversation_steer_busy')
    }
    if (!this.steerSupported) {
      throw new Error('conversation_steer_unsupported')
    }
    const id = clientMessageId
    let rejectAccepted = (_error: Error): void => undefined
    const accepted = new Promise<void>((resolve, reject) => {
      rejectAccepted = reject
      this.pending = { id, originalPromptId: this.currentPromptId, accept, resolve, reject }
    })
    try {
      const response = await this.request('x.ai/interject', {
        sessionId,
        text,
        interjectionId: id,
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...(imagePaths ?? []).map((path) => {
            const image = providerImageData(path)
            return { type: 'image', data: image.data, mimeType: image.mediaType }
          })
        ]
      })
      if (response.status !== 'queued') {
        throw new Error('grok_interject_rejected')
      }
    } catch (error) {
      this.pending = null
      if (error instanceof RequestError && error.code === -32601) {
        this.steerSupported = false
        this.onUnsupported()
        rejectAccepted(new Error('conversation_steer_unsupported'))
        return accepted
      }
      rejectAccepted(
        error instanceof RequestError ||
          (error instanceof Error && error.message === 'grok_interject_rejected')
          ? error
          : new Error('conversation_steer_uncertain')
      )
    }
    return accepted
  }

  async observeTurn(notification: SessionNotification): Promise<void> {
    const raw = notification as unknown as {
      _meta?: { promptId?: unknown }
      update?: { sessionUpdate?: unknown; prompt_id?: unknown; stop_reason?: unknown }
    }
    const update = raw.update
    const promptId =
      typeof raw._meta?.promptId === 'string'
        ? raw._meta.promptId
        : typeof update?.prompt_id === 'string'
          ? update.prompt_id
          : null
    const type = update?.sessionUpdate
    if (promptId && type !== 'turn_completed') {
      this.currentPromptId = promptId
    }
    const pending = this.pending
    if (pending && promptId && type !== 'turn_completed') {
      if (promptId.startsWith('interject-fallback-')) {
        await this.acceptNext(pending, promptId)
      } else if (!pending.originalPromptId || promptId === pending.originalPromptId) {
        this.pending = null
        try {
          await pending.accept({ placement: 'current' })
          pending.resolve()
        } catch {
          pending.reject(new Error('conversation_steer_uncertain'))
        }
      }
    }
    if (type === 'turn_completed' && promptId) {
      this.completeFallback(promptId, update?.stop_reason)
    }
  }

  observeNotification(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | null
  ): void {
    if (
      method === 'x.ai/session/interjection' &&
      this.pending &&
      params.interjectionId === this.pending.id &&
      sessionId &&
      params.sessionId !== sessionId
    ) {
      this.rejectAll(new Error('grok_interject_session_mismatch'))
    }
  }

  rejectAll(error = new Error('conversation_steer_uncertain')): void {
    this.pending?.reject(error)
    this.pending = null
    for (const completion of this.fallbacks.values()) {
      completion.reject(error)
    }
    this.fallbacks.clear()
  }

  private async acceptNext(pending: PendingSteer, promptId: string): Promise<void> {
    let resolve = (): void => undefined
    let reject = (_error: Error): void => undefined
    const completion = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    this.fallbacks.set(promptId, { resolve, reject })
    this.pending = null
    try {
      await pending.accept({ placement: 'next', completion })
      pending.resolve()
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      pending.reject(new Error('conversation_steer_uncertain'))
    }
  }

  private completeFallback(promptId: string, stopReason: unknown): void {
    const completion = this.fallbacks.get(promptId)
    if (completion) {
      this.fallbacks.delete(promptId)
      if (stopReason === 'error') {
        completion.reject(new Error('grok_turn_failed'))
      } else if (stopReason === 'cancelled') {
        completion.reject(new Error('turn_interrupted'))
      } else {
        completion.resolve()
      }
    }
    if (this.currentPromptId === promptId) {
      this.currentPromptId = null
    }
  }
}
