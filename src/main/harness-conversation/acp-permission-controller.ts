import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { HarnessConversationDriverSink } from './driver'

export class AcpPermissionController {
  private readonly pending = new Map<string, (optionId: string | null) => void>()

  constructor(private readonly sink: HarnessConversationDriverSink) {}

  answer(requestId: string, optionId: string): void {
    this.pending.get(requestId)?.(optionId)
  }

  cancel(): void {
    for (const resolve of this.pending.values()) {
      resolve(null)
    }
  }

  request(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const id = `${request.sessionId}:${request.toolCall.toolCallId}`
    return new Promise((resolve) => {
      this.pending.set(id, (optionId) => {
        this.pending.delete(id)
        this.sink.emit({ type: 'permission', permission: null })
        resolve(
          optionId
            ? { outcome: { outcome: 'selected', optionId } }
            : { outcome: { outcome: 'cancelled' } }
        )
      })
      this.sink.emit({
        type: 'permission',
        permission: {
          id,
          title: request.toolCall.title ?? 'Tool permission',
          detail: request.toolCall.rawInput
            ? JSON.stringify(request.toolCall.rawInput, null, 2)
            : undefined,
          options: request.options.map((option) => ({
            id: option.optionId,
            label: option.name,
            kind:
              option.kind === 'allow_always'
                ? 'allow-always'
                : option.kind === 'allow_once'
                  ? 'allow-once'
                  : 'reject'
          }))
        }
      })
    })
  }
}
