import { ignoreProviderTransportError } from './provider-child'
import type { ChildProcess } from 'node:child_process'
import type { PassThrough } from 'node:stream'

/** H may outlive a chat; its stdin must not retain connection error callbacks. */
export function pipeDirectProviderInput(
  raw: ChildProcess,
  input: PassThrough,
  onFinish: () => void
): { release: () => void; end: () => void } {
  const onError = (error: Error): void => {
    input.destroy(error)
  }
  const onClose = (): void => {
    input.destroy()
  }
  input.on('error', ignoreProviderTransportError)
  raw.stdin?.once('close', onClose)
  if (raw.stdin?.destroyed) {
    onClose()
  }
  raw.stdin?.on('error', onError)
  raw.stdin?.once('finish', onFinish)
  if (raw.stdin) {
    input.pipe(raw.stdin)
  }
  return {
    release: () => {
      raw.stdin?.off('close', onClose)
      raw.stdin?.off('finish', onFinish)
      raw.stdin?.off('error', onError)
      raw.stdin?.on('error', ignoreProviderTransportError)
      input.unpipe(raw.stdin ?? undefined)
      raw.stdin?.destroy()
    },
    // Ends the CLI's input as an owner death would; later owner writes stay buffered, not failed.
    end: () => {
      input.unpipe(raw.stdin ?? undefined)
      if (raw.stdin && !raw.stdin.writableEnded) {
        raw.stdin.end()
      }
    }
  }
}
