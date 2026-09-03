import type { Readable } from 'node:stream'

/** Delivers complete lines from a child stream; the returned function detaches the listener. */
export function onProcessOutputLines(stream: Readable, onLine: (line: string) => void): () => void {
  let pending = ''
  const onData = (chunk: Buffer | string): void => {
    pending += chunk.toString()
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      if (line.length > 0) {
        onLine(line)
      }
      newline = pending.indexOf('\n')
    }
  }
  stream.on('data', onData)
  return () => {
    stream.off('data', onData)
  }
}
