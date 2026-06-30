import type { RuntimeTerminalWait, RuntimeTerminalWaitCondition } from '../../shared/runtime-types'

export class PipelineTerminalOutputError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PipelineTerminalOutputError'
    this.code = code
    this.details = details
  }
}

export type WaitForPipelineTerminalOutputInput = {
  handle: string
  expectedText: string
  timeoutMs: number
  pollIntervalMs?: number
  outputLimit?: number
  readTerminal: (
    handle: string,
    options: { limit: number }
  ) => Promise<{
    tail: string[]
  }>
  waitForTerminal: (
    handle: string,
    options: {
      condition: RuntimeTerminalWaitCondition
      timeoutMs: number
      signal: AbortSignal
    }
  ) => Promise<RuntimeTerminalWait>
}

export type WaitForPipelineTerminalOutputResult = {
  stdout: string
  wait: RuntimeTerminalWait | null
}

export async function waitForPipelineTerminalOutput(
  input: WaitForPipelineTerminalOutputInput
): Promise<WaitForPipelineTerminalOutputResult> {
  const outputLimit = input.outputLimit ?? 2_000
  const pollIntervalMs = input.pollIntervalMs ?? 1_000
  const deadline = Date.now() + input.timeoutMs
  let lastWait: RuntimeTerminalWait | null = null
  let lastStdout = ''

  while (Date.now() < deadline) {
    lastStdout = await readTerminalStdout(input, outputLimit)
    if (lastStdout.includes(input.expectedText)) {
      return { stdout: lastStdout, wait: lastWait }
    }

    const waitMs = Math.max(1, Math.min(pollIntervalMs, deadline - Date.now()))
    const startedAt = Date.now()
    const wait = await waitForPipelineTerminalSignal(input, waitMs)
    if (wait) {
      lastWait = wait
      if (!wait.satisfied) {
        throw new PipelineTerminalOutputError(
          'blocked',
          `Pipeline terminal ${input.handle} is blocked before emitting ${input.expectedText}`,
          { wait }
        )
      }
      if (wait.condition === 'exit' && wait.status === 'exited') {
        lastStdout = await readTerminalStdout(input, outputLimit)
        if (lastStdout.includes(input.expectedText)) {
          return { stdout: lastStdout, wait }
        }
        throw new PipelineTerminalOutputError(
          'missing_expected_output',
          `Pipeline terminal ${input.handle} exited before emitting ${input.expectedText}`,
          { wait, outputSnapshot: lastStdout }
        )
      }
    }

    const elapsedMs = Date.now() - startedAt
    if (elapsedMs < waitMs) {
      await delay(waitMs - elapsedMs)
    }
  }

  throw new PipelineTerminalOutputError(
    'timeout',
    `Timed out waiting for Pipeline terminal ${input.handle} to emit ${input.expectedText}`,
    { outputSnapshot: lastStdout, lastWait }
  )
}

async function readTerminalStdout(
  input: Pick<WaitForPipelineTerminalOutputInput, 'handle' | 'readTerminal'>,
  outputLimit: number
): Promise<string> {
  const read = await input.readTerminal(input.handle, { limit: outputLimit })
  return read.tail.join('\n')
}

async function waitForPipelineTerminalSignal(
  input: Pick<WaitForPipelineTerminalOutputInput, 'handle' | 'waitForTerminal'>,
  timeoutMs: number
): Promise<RuntimeTerminalWait | null> {
  const controller = new AbortController()
  try {
    return await Promise.race([
      waitForTerminalCondition(input, 'tui-idle', timeoutMs, controller.signal),
      waitForTerminalCondition(input, 'exit', timeoutMs, controller.signal)
    ])
  } finally {
    controller.abort()
  }
}

async function waitForTerminalCondition(
  input: Pick<WaitForPipelineTerminalOutputInput, 'handle' | 'waitForTerminal'>,
  condition: RuntimeTerminalWaitCondition,
  timeoutMs: number,
  signal: AbortSignal
): Promise<RuntimeTerminalWait | null> {
  try {
    return await input.waitForTerminal(input.handle, { condition, timeoutMs, signal })
  } catch (error) {
    if (error instanceof Error && isExpectedWaitError(error.message)) {
      return null
    }
    throw error
  }
}

function isExpectedWaitError(message: string): boolean {
  return message === 'timeout' || message === 'request_aborted' || message === 'terminal_exited'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
