import { StringDecoder } from 'node:string_decoder'
import { terminalSafe } from '../../../../../../shared/terminal/output/terminal-safe-text'
import { appendNativeChatShellOutput } from '../../../../../../shared/native-chat/input/native-chat-shell-command'
import type { AgentSessionShellOutputChunk } from '../../../../../../shared/rpc-contract/structured-agent-session-shell-command-params'

type ShellStream = AgentSessionShellOutputChunk['stream']

const FLUSH_MS = 80
const ESC = '\u001b'
const BEL = '\u0007'

function unfinishedEscapeStart(text: string): number {
  const start = text.lastIndexOf(ESC)
  if (start === -1) {
    return -1
  }
  const rest = text.slice(start + 1)
  const complete = rest.startsWith('[')
    ? /^\[[0-?]*[ -/]*[@-~]/.test(rest)
    : rest.startsWith(']')
      ? rest.includes(BEL)
      : /^[ -/]*[0-~]/.test(rest)
  return complete ? -1 : start
}

export function createShellOutputStream(
  emit: (chunks: AgentSessionShellOutputChunk[]) => void,
  maxBytes: number
): {
  push: (stream: ShellStream, chunk: Buffer | string) => void
  finish: () => { overflowed: boolean }
} {
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  const unfinishedEscapes = { stdout: '', stderr: '' }
  let pending: AgentSessionShellOutputChunk[] = []
  let emittedBytes = 0
  let overflowed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const sanitize = (stream: ShellStream, text: string, final: boolean): string => {
    let raw = unfinishedEscapes[stream] + text
    unfinishedEscapes[stream] = ''
    const unfinished = final ? -1 : unfinishedEscapeStart(raw)
    if (unfinished !== -1) {
      unfinishedEscapes[stream] = raw.slice(unfinished)
      raw = raw.slice(0, unfinished)
    }
    return terminalSafe(raw)
  }
  const queue = (stream: ShellStream, text: string): void => {
    if (text) {
      pending = appendNativeChatShellOutput(pending, { stream, text })
    }
  }
  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    const chunks = pending
    pending = []
    if (overflowed || chunks.length === 0) {
      return
    }
    const bytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text), 0)
    if (emittedBytes + bytes > maxBytes) {
      overflowed = true
      return
    }
    emittedBytes += bytes
    emit(chunks)
  }

  return {
    push: (stream, chunk) => {
      if (overflowed) {
        return
      }
      const text = typeof chunk === 'string' ? chunk : decoders[stream].write(chunk)
      queue(stream, sanitize(stream, text, false))
      timer ??= setTimeout(flush, FLUSH_MS)
    },
    finish: () => {
      for (const stream of ['stdout', 'stderr'] as const) {
        queue(stream, sanitize(stream, decoders[stream].end(), true))
      }
      flush()
      return { overflowed }
    }
  }
}

function fromLineStart(text: string, capBytes: number): string {
  const lineStart = text.indexOf('\n')
  return Buffer.byteLength(text) >= capBytes && lineStart !== -1 ? text.slice(lineStart + 1) : text
}

export function shellOutputTail(
  stdout: string,
  stderr: string,
  capBytes: number
): AgentSessionShellOutputChunk[] {
  const tail: AgentSessionShellOutputChunk[] = []
  for (const [stream, text] of [
    ['stdout', stdout],
    ['stderr', stderr]
  ] as const) {
    const kept = terminalSafe(fromLineStart(text, capBytes))
    if (kept) {
      tail.push({ stream, text: kept })
    }
  }
  return tail
}
