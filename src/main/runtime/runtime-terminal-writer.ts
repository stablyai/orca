import { resolveAgentPromptSubmitDelayForAgent } from '../../shared/agent-prompt-injection'
import type { TerminalAgent } from '../../shared/terminal-agent'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import { writeRefused, type WriteSettlement } from '../../shared/pty-write-settlement'
import type { NativeChatInputWriteResult } from '../../shared/native-chat-input-action'

export type RuntimeTerminalWriteOptions = {
  inputKind: TerminalInputKind
  signal?: AbortSignal
  beforeWrite?: (ptyId: string) => void | Promise<void>
  reserveWrite?: (ptyId: string) => void
  afterWrite?: (ptyId: string) => void | Promise<void>
  suffixFailureError?: string
}

export type RuntimeChatInputWriteResult = NativeChatInputWriteResult

export type RuntimeChatInputWriteOptions = RuntimeTerminalWriteOptions & {
  /** The chat action's fence, rechecked after every other await, right before each chunk/suffix. */
  admit: () => 'admitted' | 'refused' | Promise<'admitted' | 'refused'>
}

export class RuntimeTerminalWriter {
  constructor(
    private readonly write: (ptyId: string, data: string, inputKind: TerminalInputKind) => boolean,
    private readonly getWriteHostPlatform: (ptyId: string) => NodeJS.Platform = () =>
      process.platform,
    private readonly getAgent: (ptyId: string) => TerminalAgent | null = () => null,
    private readonly writeSettled?: (
      ptyId: string,
      data: string,
      inputKind: TerminalInputKind
    ) => WriteSettlement | Promise<WriteSettlement> | undefined
  ) {}

  /**
   * Chat composer input: each chunk and the suffix waits for transport settlement and rechecks
   * the action fence first, so a proven agent exit, a refusal or a lost settlement stops the rest.
   */
  async writeChatInputAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    options: RuntimeChatInputWriteOptions
  ): Promise<RuntimeChatInputWriteResult> {
    let bytesWritten = 0
    const writeOne = async (data: string): Promise<RuntimeChatInputWriteResult | null> => {
      await options.beforeWrite?.(ptyId)
      if ((await options.admit()) !== 'admitted') {
        return { accepted: false, bytesWritten, refusedReason: 'agent-exited' }
      }
      options.reserveWrite?.(ptyId)
      let settlement: WriteSettlement
      try {
        settlement = await (this.writeSettled?.(ptyId, data, options.inputKind) ??
          writeRefused('provider_cannot_settle'))
      } catch {
        // Why unknown: a throwing transport may have sent part of this chunk after the prefix.
        return { accepted: false, bytesWritten, deliveryUnknown: true }
      }
      if (settlement.outcome === 'refused') {
        return { accepted: false, bytesWritten }
      }
      if (settlement.outcome === 'unverifiable') {
        return { accepted: false, bytesWritten, deliveryUnknown: true }
      }
      bytesWritten += Buffer.byteLength(data, 'utf8')
      await options.afterWrite?.(ptyId)
      return null
    }
    const text = typeof action.text === 'string' ? action.text : ''
    const chunks = iterateTerminalInputChunks(text)
    let chunk = chunks.next()
    while (!chunk.done) {
      const stopped = await writeOne(chunk.value)
      if (stopped) {
        return stopped
      }
      chunk = chunks.next()
      if (!chunk.done) {
        await yieldBetweenTerminalInputChunks()
      }
    }
    if (action.enter || action.interrupt) {
      if (text) {
        await waitForTerminalWriteDelay(
          resolveAgentPromptSubmitDelayForAgent(
            this.getWriteHostPlatform(ptyId),
            text,
            this.getAgent(ptyId)
          ),
          options.signal
        )
      }
      const stopped = await writeOne((action.enter ? '\r' : '') + (action.interrupt ? '\x03' : ''))
      if (stopped) {
        return stopped
      }
    }
    return { accepted: true, bytesWritten }
  }

  async writeAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<void> {
    // Why: direct terminal.send can carry paste-sized text from RPC/mobile
    // clients; chunk text before PTY/ConPTY while preserving suffix separation.
    const text = typeof action.text === 'string' ? action.text : ''
    const hasSuffix = action.enter || action.interrupt
    if (text) {
      await this.writeChunks(ptyId, text, options)
    }
    if (hasSuffix) {
      const suffix = (action.enter ? '\r' : '') + (action.interrupt ? '\x03' : '')
      if (text) {
        // Why: same hazard as the agent-prompt path -- Enter must not overtake text the
        // execution host is still ingesting, and a flat 500 ms cannot cover 16 MB.
        await waitForTerminalWriteDelay(
          resolveAgentPromptSubmitDelayForAgent(
            this.getWriteHostPlatform(ptyId),
            text,
            this.getAgent(ptyId)
          ),
          options.signal
        )
      }
      try {
        await options.beforeWrite?.(ptyId)
      } catch (error) {
        if (options.suffixFailureError) {
          throw new Error(options.suffixFailureError)
        }
        throw error
      }
      options.reserveWrite?.(ptyId)
      if (!this.write(ptyId, suffix, options.inputKind)) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
      await options.afterWrite?.(ptyId)
      return
    }
    if (text) {
      return
    }
    await options.beforeWrite?.(ptyId)
    options.reserveWrite?.(ptyId)
    if (!this.write(ptyId, payload, options.inputKind)) {
      throw new Error('terminal_not_writable')
    }
    await options.afterWrite?.(ptyId)
  }

  async writeChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<void> {
    const chunks = iterateTerminalInputChunks(text)
    let chunk = chunks.next()
    while (!chunk.done) {
      await options.beforeWrite?.(ptyId)
      options.reserveWrite?.(ptyId)
      if (!this.write(ptyId, chunk.value, options.inputKind)) {
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
