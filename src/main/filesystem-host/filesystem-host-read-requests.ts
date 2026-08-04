import {
  filesystemHostOperationSchema,
  type FilesystemHostChildMessage,
  type FilesystemHostOperation,
  type FilesystemHostParentMessage,
  type FilesystemHostResult
} from '../../shared/filesystem-host-protocol'
import { FilesystemHostProcessError } from './filesystem-host-process-error'

type ReadResultMessage = Extract<FilesystemHostChildMessage, { type: 'result' }>
type Send = (message: FilesystemHostParentMessage, onError?: () => void) => void

type PendingRequest = {
  operationKind: FilesystemHostOperation['kind']
  resolve: (result: FilesystemHostResult) => void
  reject: (error: FilesystemHostProcessError) => void
  timer: ReturnType<typeof setTimeout>
}

export class FilesystemHostReadRequests {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly send: Send) {}

  invoke(
    operation: FilesystemHostOperation,
    deadlineMs: number,
    requestId: string
  ): Promise<FilesystemHostResult> {
    const parsedOperation = filesystemHostOperationSchema.safeParse(operation)
    if (!parsedOperation.success) {
      return Promise.reject(
        new FilesystemHostProcessError('protocol', 'Invalid filesystem host operation')
      )
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new FilesystemHostProcessError('deadline', 'Filesystem operation timed out'))
      }, deadlineMs)
      timer.unref?.()
      this.pending.set(requestId, {
        operationKind: parsedOperation.data.kind,
        resolve,
        reject,
        timer
      })
      this.send({ type: 'request', requestId, operation: parsedOperation.data }, () => {
        const pending = this.pending.get(requestId)
        if (!pending) {
          return
        }
        clearTimeout(pending.timer)
        this.pending.delete(requestId)
        pending.reject(
          new FilesystemHostProcessError('process-unavailable', 'Filesystem host send failed')
        )
      })
    })
  }

  handle(message: ReadResultMessage): void {
    const pending = this.pending.get(message.requestId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(message.requestId)
    if (message.ok) {
      if (message.result.kind === pending.operationKind) {
        pending.resolve(message.result)
      } else {
        pending.reject(
          new FilesystemHostProcessError('protocol', 'Filesystem host returned a mismatched result')
        )
      }
      return
    }
    pending.reject(
      new FilesystemHostProcessError('operation', message.error.message, message.error.code)
    )
  }

  rejectAll(message: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.reject(new FilesystemHostProcessError('process-unavailable', message))
    }
  }
}
