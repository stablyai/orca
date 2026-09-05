import { AsyncLocalStorage } from 'node:async_hooks'
import {
  RuntimeRpcCallQueueOverloadError,
  RuntimeRpcCallQueuePool
} from '../../shared/runtime-rpc-call-queue'
import {
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../shared/terminal-input'
import { InvalidArgumentError } from './rpc/core'
import { AgentSessionPtyWriteRefusedError } from '../../shared/agent-session-pty-write-admission'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'

export type TerminalInputArrivalTarget = {
  ptyId: string
  generation: number
  assertCurrent: () => void
}

type TerminalInputArrivalRuntime = {
  captureTerminalInputArrivalTarget: (handle: string) => TerminalInputArrivalTarget
}

type TerminalInputArrival = {
  assertWrite: (ptyId: string) => void
}

const arrivals = new WeakMap<TerminalInputArrivalRuntime, RuntimeRpcCallQueuePool>()
const currentArrival = new AsyncLocalStorage<TerminalInputArrival>()

export function captureTerminalInputArrivalWriteGuard(): (ptyId: string) => void {
  const arrival = currentArrival.getStore()
  return (ptyId) => arrival?.assertWrite(ptyId)
}

// Reserve before dispatch, validation, or viewport claims can yield to the next frame.
export async function runTerminalInputInArrivalOrder<T>(
  runtime: TerminalInputArrivalRuntime,
  handle: string,
  retainedCodeUnits: number,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  capturedTarget?: TerminalInputArrivalTarget
): Promise<T> {
  if (signal?.aborted) {
    throw new Error('request_aborted')
  }
  const target = capturedTarget ?? runtime.captureTerminalInputArrivalTarget(handle)
  target.assertCurrent()
  const admission = agentSessionPtyWriteGate.admit(target.ptyId)
  let queue = arrivals.get(runtime)
  if (!queue) {
    queue = new RuntimeRpcCallQueuePool(1, 1, 1023, 2048, (TERMINAL_INPUT_MAX_BYTES + 2) * 2)
    arrivals.set(runtime, queue)
  }
  const assertCurrent = (): void => {
    if (signal?.aborted) {
      throw new Error('request_aborted')
    }
    target.assertCurrent()
  }
  const arrival: TerminalInputArrival = {
    assertWrite: (ptyId) => {
      assertCurrent()
      if (ptyId !== target.ptyId) {
        throw new Error('terminal_handle_stale')
      }
      if (!admission.admitted) {
        throw new AgentSessionPtyWriteRefusedError(admission.refusal)
      }
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admission)
    }
  }
  try {
    return await queue.enqueue(
      `${target.ptyId}\0${target.generation}`,
      'terminal.send',
      () => {
        assertCurrent()
        return currentArrival.run(arrival, run)
      },
      retainedCodeUnits * 2,
      signal
    )
  } catch (error) {
    if (signal?.aborted) {
      throw new Error('request_aborted')
    }
    if (error instanceof RuntimeRpcCallQueueOverloadError) {
      throw new Error('terminal_input_queue_full')
    }
    throw error
  }
}

// A read-only subscription can survive an unavailable input target; its input cannot migrate.
export function captureTerminalStreamInputTarget(
  runtime: TerminalInputArrivalRuntime,
  handle: string,
  ptyId: string
): TerminalInputArrivalTarget {
  try {
    const target = runtime.captureTerminalInputArrivalTarget(handle)
    if (target.ptyId !== ptyId) {
      throw new Error('terminal_handle_stale')
    }
    return target
  } catch (error) {
    return {
      ptyId,
      generation: -1,
      assertCurrent: () => {
        throw error
      }
    }
  }
}

export function runTerminalRpcInArrivalOrder<T>(
  runtime: TerminalInputArrivalRuntime,
  method: string,
  params: unknown,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (method !== 'terminal.send') {
    return run()
  }
  const input = params as {
    terminal: string
    text?: string
    resolvedLaunchDraft?: { text?: string }
  }
  if (
    (input.text?.length ?? 0) > TERMINAL_INPUT_MAX_BYTES ||
    (input.resolvedLaunchDraft?.text?.length ?? 0) > TERMINAL_INPUT_MAX_BYTES
  ) {
    return Promise.reject(new InvalidArgumentError(TERMINAL_INPUT_TOO_LARGE_ERROR))
  }
  return runTerminalInputInArrivalOrder(
    runtime,
    input.terminal,
    (input.text?.length ?? 0) + (input.resolvedLaunchDraft?.text?.length ?? 0) + 2,
    signal,
    run
  )
}
