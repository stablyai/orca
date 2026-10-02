import type { HarnessConversationDriverSink } from './driver'
import type { OmpRpcFrame } from './omp-rpc-connection'

type PendingUi = { method: string; options?: string[] }

export class OmpRpcInteractions {
  private readonly pending = new Map<string, PendingUi>()

  constructor(
    private readonly sink: HarnessConversationDriverSink,
    private readonly write: (frame: OmpRpcFrame) => void
  ) {}

  answerPermission(requestId: string, optionId: string): void {
    if (!this.pending.has(requestId)) {
      return
    }
    this.pending.delete(requestId)
    this.sink.emit({ type: 'permission', permission: null })
    this.write({ type: 'extension_ui_response', id: requestId, value: optionId })
  }

  answerInput(requestId: string, answers: Record<string, string[]>): void {
    const pending = this.pending.get(requestId)
    if (!pending) {
      return
    }
    this.pending.delete(requestId)
    this.sink.emit({ type: 'input', input: null })
    const value = answers.value?.[0]
    this.write(
      pending.method === 'confirm'
        ? { type: 'extension_ui_response', id: requestId, confirmed: value === 'yes' }
        : value
          ? { type: 'extension_ui_response', id: requestId, value }
          : { type: 'extension_ui_response', id: requestId, cancelled: true }
    )
  }

  handle(frame: OmpRpcFrame): void {
    const id = typeof frame.id === 'string' ? frame.id : null
    const method = typeof frame.method === 'string' ? frame.method : null
    if (!id || !method) {
      return
    }
    if (method === 'open_url') {
      this.openUrl(id, frame)
      return
    }
    if (method === 'cancel' && typeof frame.targetId === 'string') {
      this.pending.delete(frame.targetId)
      this.sink.emit({ type: 'permission', permission: null })
      this.sink.emit({ type: 'input', input: null })
      return
    }
    const options = Array.isArray(frame.options)
      ? frame.options.filter((value): value is string => typeof value === 'string')
      : []
    if (method === 'select' && options.includes('Approve') && options.includes('Deny')) {
      this.pending.set(id, { method, options })
      this.sink.emit({
        type: 'permission',
        permission: {
          id,
          title: typeof frame.title === 'string' ? frame.title : 'Tool permission',
          ...(typeof frame.message === 'string' ? { detail: frame.message } : {}),
          options: options.map((label) => ({
            id: label,
            label,
            kind: label === 'Approve' ? ('allow-once' as const) : ('reject' as const)
          }))
        }
      })
      return
    }
    if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
      this.pending.set(id, { method, options })
      this.sink.emit({
        type: 'input',
        input: {
          id,
          questions: [
            {
              id: 'value',
              header: 'OMP',
              question:
                typeof frame.message === 'string'
                  ? frame.message
                  : typeof frame.title === 'string'
                    ? frame.title
                    : 'Input required',
              ...(method === 'confirm'
                ? { options: [{ label: 'yes' }, { label: 'no' }] }
                : options.length
                  ? { options: options.map((label) => ({ label })) }
                  : { allowOther: true })
            }
          ]
        }
      })
    }
  }

  private openUrl(id: string, frame: OmpRpcFrame): void {
    const url = typeof frame.url === 'string' ? frame.url : frame.launchUrl
    if (typeof url !== 'string') {
      return
    }
    this.sink.emit({
      type: 'message.completed',
      message: {
        id: `omp:url:${id}`,
        role: 'system',
        blocks: [{ type: 'text', text: `Open this URL to continue: ${url}` }],
        timestamp: Date.now(),
        source: 'stream'
      }
    })
  }
}
