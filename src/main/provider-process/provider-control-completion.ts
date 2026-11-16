import { ignoreProviderTransportError } from './provider-child'
import type { Readable } from 'node:stream'

export type ProviderControlCompletion = 'group-absent' | 'group-unverifiable'

/** EOF is evidence only after one exact frame; the watcher retains fd3 until _exit. */
export function readProviderControlCompletion(
  stream: Readable,
  completed: (completion?: ProviderControlCompletion) => void
): void {
  let buffer = ''
  let bytes = 0
  let finished = false
  const finish = (completion?: ProviderControlCompletion): void => {
    if (!finished) {
      finished = true
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('close', onClose)
      stream.off('error', onClose)
      stream.on('error', ignoreProviderTransportError)
      completed(completion)
    }
  }
  const onData = (chunk: Buffer): void => {
    if (finished) {
      return
    }
    bytes += chunk.length
    if (bytes > 32) {
      finish()
      stream.destroy()
      return
    }
    buffer += chunk.toString('utf8')
  }
  const onEnd = (): void => {
    finish(
      buffer === 'group-absent\n'
        ? 'group-absent'
        : buffer === 'group-unverifiable\n'
          ? 'group-unverifiable'
          : undefined
    )
  }
  const onClose = (): void => finish()
  stream.on('data', onData)
  stream.once('end', onEnd)
  stream.once('close', onClose)
  stream.on('error', onClose)
  stream.resume()
}
