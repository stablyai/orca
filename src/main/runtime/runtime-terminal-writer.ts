import { getAgentPromptSubmitDelayMs } from '../../shared/agent-prompt-injection'
import { iterateTerminalInputChunks, TERMINAL_INPUT_MAX_BYTES } from '../../shared/terminal-input'
import {
  RuntimeRpcCallQueuePool,
  RuntimeRpcCallQueueOverloadError
} from '../../shared/runtime-rpc-call-queue'
import {
  agentSessionPtyWriteGate,
  type AgentSessionPtyWriteAdmittance
} from './agent-session-pty-write-gate'

const MAX_PENDING_WRITES_PER_PTY = 1024
const MAX_PENDING_WRITE_CODE_UNITS = TERMINAL_INPUT_MAX_BYTES + 2

export type RuntimeTerminalWriteOptions = {
  signal?: AbortSignal
  beforeWrite?: (ptyId: string) => void | Promise<void>
  reserveWrite?: (ptyId: string) => void
  afterWrite?: (ptyId: string) => void | Promise<void>
  suffixFailureError?: string
}

export class RuntimeTerminalWriter {
  private readonly writes = new RuntimeRpcCallQueuePool(
    1,
    1,
    MAX_PENDING_WRITES_PER_PTY - 1,
    2048,
    MAX_PENDING_WRITE_CODE_UNITS * 2
  )

  constructor(
    private readonly write: (ptyId: string, data: string) => boolean,
    private readonly getWriteHostPlatform: (ptyId: string) => NodeJS.Platform = () =>
      process.platform,
    private readonly getPtyGeneration: (
      ptyId: string,
      initialize: boolean
    ) => number | undefined = () => 0
  ) {}

  async writeAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<void> {
    // Why: the lease is checked before the mobile floor is reserved, so a refused send never takes
    // a claim it will not use.
    const admitted = agentSessionPtyWriteGate.assertAdmitted(ptyId)
    return this.serialize(ptyId, payload.length, options, (guardedOptions) =>
      this.writeAdmittedAction(ptyId, action, payload, guardedOptions, admitted)
    )
  }

  private async writeAdmittedAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions,
    admitted: AgentSessionPtyWriteAdmittance
  ): Promise<void> {
    // Why: direct terminal.send can carry paste-sized text from RPC/mobile
    // clients; chunk text before PTY/ConPTY while preserving suffix separation.
    const text = typeof action.text === 'string' ? action.text : ''
    const hasSuffix = action.enter || action.interrupt
    if (text) {
      await this.writeAdmittedChunks(ptyId, text, options, admitted)
    }
    if (hasSuffix) {
      const suffix = (action.enter ? '\r' : '') + (action.interrupt ? '\x03' : '')
      if (text) {
        // Why: same hazard as the agent-prompt path -- Enter must not overtake text the
        // execution host is still ingesting, and a flat 500 ms cannot cover 16 MB.
        await waitForTerminalWriteDelay(
          getAgentPromptSubmitDelayMs(
            this.getWriteHostPlatform(ptyId),
            Buffer.byteLength(text, 'utf8')
          ),
          options.signal
        )
      }
      // Why: the 500ms text/suffix pause is long enough for a handoff to complete, so the submit
      // is re-checked against the fence the text was admitted under.
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      try {
        await options.beforeWrite?.(ptyId)
      } catch (error) {
        if (options.suffixFailureError) {
          throw new Error(options.suffixFailureError)
        }
        throw error
      }
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      options.reserveWrite?.(ptyId)
      if (!this.write(ptyId, suffix)) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
      await options.afterWrite?.(ptyId)
      return
    }
    if (text) {
      return
    }
    await options.beforeWrite?.(ptyId)
    agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
    options.reserveWrite?.(ptyId)
    if (!this.write(ptyId, payload)) {
      throw new Error('terminal_not_writable')
    }
    await options.afterWrite?.(ptyId)
  }

  async writeChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions = {},
    admitted: AgentSessionPtyWriteAdmittance = agentSessionPtyWriteGate.assertAdmitted(ptyId)
  ): Promise<void> {
    return this.serialize(ptyId, text.length, options, (guardedOptions) =>
      this.writeAdmittedChunks(ptyId, text, guardedOptions, admitted)
    )
  }

  private serialize(
    ptyId: string,
    codeUnits: number,
    options: RuntimeTerminalWriteOptions,
    write: (options: RuntimeTerminalWriteOptions) => Promise<void>
  ): Promise<void> {
    if (options.signal?.aborted) {
      return Promise.reject(new Error('request_aborted'))
    }
    const generation = this.getPtyGeneration(ptyId, true)
    const key = `${ptyId}\0${generation}`
    const assertCurrent = (): void => {
      if (options.signal?.aborted) {
        throw new Error('request_aborted')
      }
      if (generation === undefined || this.getPtyGeneration(ptyId, false) !== generation) {
        throw new Error('terminal_handle_stale')
      }
    }
    return this.writes
      .enqueue(
        key,
        'terminal.send',
        async () => {
          assertCurrent()
          await write({
            ...options,
            beforeWrite: async (writePtyId) => {
              assertCurrent()
              await options.beforeWrite?.(writePtyId)
              assertCurrent()
            },
            // beforeWrite's await can admit another microtask after its final guard.
            reserveWrite: (writePtyId) => {
              assertCurrent()
              options.reserveWrite?.(writePtyId)
              assertCurrent()
            }
          })
        },
        codeUnits * 2,
        options.signal
      )
      .catch((error: unknown) => {
        if (options.signal?.aborted) {
          throw new Error('request_aborted')
        }
        if (error instanceof RuntimeRpcCallQueueOverloadError) {
          throw new Error('terminal_input_queue_full')
        }
        throw error
      })
  }

  private async writeAdmittedChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions,
    admitted: AgentSessionPtyWriteAdmittance
  ): Promise<void> {
    const chunks = iterateTerminalInputChunks(text)
    let chunk = chunks.next()
    let firstChunk = true
    while (!chunk.done) {
      if (!firstChunk) {
        agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      }
      firstChunk = false
      await options.beforeWrite?.(ptyId)
      agentSessionPtyWriteGate.assertReadmitted(ptyId, admitted)
      options.reserveWrite?.(ptyId)
      if (!this.write(ptyId, chunk.value)) {
        throw new Error('terminal_not_writable')
      }
      await options.afterWrite?.(ptyId)
      chunk = chunks.next()
      if (!chunk.done) {
        await yieldBetweenTerminalInputChunks()
      }
    }
  }
}

function yieldBetweenTerminalInputChunks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

async function waitForTerminalWriteDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return
  }
  if (signal.aborted) {
    throw new Error('request_aborted')
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
  })
}
