import { ignoreProviderTransportError } from './provider-child'
import type { PassThrough, Writable } from 'node:stream'

/** CLI input must survive H's exit and release its connection when the CLI retires. */
export function pipeDirectProviderInput(
  destination: Writable | undefined,
  input: PassThrough,
  onFinish: () => void,
  onEnd: () => void
): { release: () => void; end: () => void } {
  let released = false
  const onError = (error: Error): void => {
    input.destroy(error)
  }
  const onClose = (): void => {
    input.destroy()
  }
  input.on('error', ignoreProviderTransportError)
  destination?.once('close', onClose)
  if (destination?.destroyed) {
    onClose()
  }
  destination?.on('error', onError)
  destination?.once('finish', onFinish)
  input.once('end', onEnd)
  if (destination) {
    // EOF is an ownership action too: a pending fault must capture before it is delivered.
    input.pipe(destination, { end: false })
  }
  return {
    release: () => {
      if (released) {
        return
      }
      released = true
      input.off('end', onEnd)
      destination?.off('close', onClose)
      destination?.off('finish', onFinish)
      destination?.off('error', onError)
      destination?.on('error', ignoreProviderTransportError)
      input.unpipe(destination)
      destination?.destroy()
    },
    // Ends the CLI's input as an owner death would; later owner writes stay buffered, not failed.
    end: () => {
      input.unpipe(destination)
      if (destination && !destination.destroyed && !destination.writableEnded) {
        destination.end()
      }
    }
  }
}
