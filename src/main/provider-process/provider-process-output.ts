import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { waitForProcessExitUntil } from './provider-process-exit-deadline'
import { PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS } from './provider-process-timing'

const STDERR_TAIL_MAX_CHARS = 8192
export type ProviderProcessOutputOptions = {
  onOutput?: () => void
  /** True withholds a classified stderr line from the diagnostic tail. */
  onStderrLine?: (line: string, cut: boolean) => boolean
  stderrLineMaxChars?: number
}

/** Output remains readable through physical exit, with a deadline for inherited pipes. */
export function observeProviderOutput(
  child: PipedChildProcess,
  options: ProviderProcessOutputOptions,
  capture: () => void
): { stderrTail(): string; drain(): Promise<void> } {
  let stderrTail = ''
  let stderrLine = ''
  let lineCut = false
  const lineMaxChars = options.stderrLineMaxChars ?? STDERR_TAIL_MAX_CHARS
  // A line cut at the cap was classified on its prefix only, so an unrecognised one is dropped,
  // not kept: whatever follows the prefix (a sign-in URL) must never reach the tail.
  const retainLine = (line: string, cut: boolean): void => {
    if (line && !options.onStderrLine?.(line, cut) && !cut) {
      stderrTail = `${stderrTail}${line}\n`.slice(-STDERR_TAIL_MAX_CHARS)
    }
  }
  // An undrained stderr pipe blocks the child once it fills.
  let lastOutputCapture = 0
  const captureOnOutput = (): void => {
    if (Date.now() - lastOutputCapture >= 5_000) {
      lastOutputCapture = Date.now()
      capture()
    }
  }
  observeReaderOutput(child.stdout, captureOnOutput)
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    captureOnOutput()
    if (options.onStderrLine) {
      const lines = (stderrLine + chunk).split('\n')
      const pending = lines.pop() ?? ''
      // Keep the prompt prefix until the complete line can be classified.
      lines.forEach((line, index) => retainLine(line, index === 0 && lineCut))
      lineCut = (lines.length === 0 && lineCut) || pending.length > lineMaxChars
      stderrLine = pending.slice(0, lineMaxChars)
    } else {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS)
    }
    options.onOutput?.()
  })
  child.stderr.once('end', () => retainLine(stderrLine, lineCut))
  if (options.onOutput) {
    observeReaderOutput(child.stdout, options.onOutput)
  }
  let outputClosed = false
  let resolveOutput = (): void => {}
  const outputEnd = new Promise<void>((resolve) => {
    resolveOutput = resolve
  })
  child.once('close', () => {
    outputClosed = true
    resolveOutput()
  })
  let drained: Promise<void> | undefined
  const drain = (): Promise<void> =>
    (drained ??= (async () => {
      if (!outputClosed) {
        await waitForProcessExitUntil(outputEnd, PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS)
      }
      if (!outputClosed) {
        child.stdout.destroy()
        child.stderr.destroy()
      }
    })())
  return { stderrTail: () => stderrTail, drain }
}

/** Watches stdout only once its reader subscribes: a listener of our own would start the stream
 *  flowing and drop whatever arrived before a reader that subscribes late. */
function observeReaderOutput(
  stdout: Pick<NodeJS.ReadableStream, 'on' | 'removeListener'>,
  onOutput: () => void
): void {
  const onSubscribe = (event: string | symbol): void => {
    if (event !== 'data' && event !== 'readable') {
      return
    }
    stdout.removeListener('newListener', onSubscribe)
    // After the reader's own listener lands; no chunk can arrive before a microtask runs.
    queueMicrotask(() => stdout.on('data', onOutput))
  }
  stdout.on('newListener', onSubscribe)
}
