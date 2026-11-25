import type {
  WslTranscriptFsProcessCall,
  WslTranscriptFsProcessRequest
} from './wsl-transcript-fs-process-protocol'
import type {
  ProcessSlot,
  SlotDisposition,
  WslTranscriptFsProcessHandle
} from './wsl-transcript-fs-process-slot'

export function sendWslTranscriptFsProcessRequest<T>(args: {
  slot: ProcessSlot
  id: number
  request: WslTranscriptFsProcessCall
  signal: AbortSignal
  disposition: SlotDisposition
  handle?: WslTranscriptFsProcessHandle
  onAbort: (reason: unknown) => void
  onTransportFailure: (error: unknown) => void
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      if (args.slot.active?.id === args.id) {
        args.onAbort(args.signal.reason ?? new Error('WSL filesystem process aborted'))
      }
    }
    args.slot.active = {
      id: args.id,
      resolve: resolve as (value: unknown) => void,
      reject,
      signal: args.signal,
      onAbort,
      operation: args.request.operation,
      disposition: args.disposition,
      handle: args.handle
    }
    args.signal.addEventListener('abort', onAbort, { once: true })
    try {
      args.slot.child.send(
        { ...args.request, id: args.id } as WslTranscriptFsProcessRequest,
        (error) => {
          if (error && args.slot.active?.id === args.id) {
            args.onTransportFailure(error)
          }
        }
      )
    } catch (error) {
      args.onTransportFailure(error)
    }
  })
}
