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
      completed(completion)
    }
  }
  stream.on('data', (chunk: Buffer) => {
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
  })
  stream.once('end', () => {
    finish(
      buffer === 'group-absent\n'
        ? 'group-absent'
        : buffer === 'group-unverifiable\n'
          ? 'group-unverifiable'
          : undefined
    )
  })
  stream.once('close', () => finish())
  stream.on('error', () => finish())
  stream.resume()
}
