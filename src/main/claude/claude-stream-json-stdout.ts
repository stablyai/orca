import type { Readable } from 'node:stream'

export type ClaudeStreamJsonStdout = {
  flush: () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function attachClaudeStreamJsonStdout(input: {
  stdout: Readable
  maxLineBytes: number
  onMessage: (message: Record<string, unknown>) => void
  onFailure: (error: Error) => void
}): ClaudeStreamJsonStdout {
  let buffer = ''
  let stopped = false

  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    buffer = ''
    input.stdout.removeListener('data', onData)
    input.stdout.pause()
  }
  const fail = (error: Error): void => {
    stop()
    input.onFailure(error)
  }
  const parseLine = (line: string): void => {
    if (!line.trim()) {
      return
    }
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed)) {
        input.onMessage(parsed)
      }
    } catch (error) {
      fail(new Error('claude emitted invalid stream-json', { cause: error }))
    }
  }
  const onData = (chunk: string): void => {
    if (stopped) {
      return
    }
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line, 'utf8') > input.maxLineBytes) {
        fail(new Error('claude emitted an oversized stream-json line'))
        return
      }
      parseLine(line)
      if (stopped) {
        return
      }
      newline = buffer.indexOf('\n')
    }
    if (Buffer.byteLength(buffer, 'utf8') > input.maxLineBytes) {
      fail(new Error('claude emitted an oversized stream-json line'))
    }
  }

  input.stdout.setEncoding('utf8').on('data', onData)
  return {
    flush: () => {
      if (!stopped && buffer.trim()) {
        const line = buffer
        buffer = ''
        parseLine(line)
      }
    }
  }
}
