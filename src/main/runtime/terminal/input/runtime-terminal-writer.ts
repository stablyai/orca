import { getTerminalTextSubmitDelay } from '../../../../shared/agent-launch/startup/agent-prompt-injection'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import { iterateTerminalInputChunks } from '../../../../shared/terminal/input/terminal-input'
import type { TerminalInputSource } from './terminal-input-admission'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'
import type { OwnTerminalInputTrack } from '../lifecycle/terminal-run-facts'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

export type RuntimeTerminalWriteOptions = {
  inputSource?: TerminalInputSource
  inputKind: TerminalInputKind
  signal?: AbortSignal
  beforeWrite?: (ptyId: string) => void | Promise<void>
  reserveWrite?: (ptyId: string) => void
  afterWrite?: (ptyId: string) => void | Promise<void>
  suffixFailureError?: string
  requireWriteSettlement?: true
  /** Hold an Enter until a fresh launch's composer is up, refusing the send if it never comes (#34580). */
  waitForLaunchComposer?: true
  /** A paste whose Enter the client sends itself, if at all. */
  clientSubmit?: true
  ownInput?: OwnTerminalInputTrack
}

export class RuntimeTerminalWriter {
  constructor(
    private readonly write: (ptyId: string, data: string, inputKind: TerminalInputKind) => boolean,
    private readonly getWriteHostPlatform: (ptyId: string) => NodeJS.Platform = () =>
      process.platform,
    private readonly getAgent: (ptyId: string) => TerminalAgent | null = () => null,
    private readonly writeWithSettlement?: (
      ptyId: string,
      data: string,
      inputKind: TerminalInputKind
    ) => WriteSettlement | Promise<WriteSettlement>,
    private readonly claimIdleShellPrompt: (ptyId: string) => Promise<boolean> = async () => false
  ) {}

  async writeAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    let acknowledgedPrefix = false
    const guardedOptions = options.requireWriteSettlement
      ? {
          ...options,
          afterWrite: async (id: string): Promise<void> => {
            acknowledgedPrefix = true
            await options.afterWrite?.(id)
          }
        }
      : options
    try {
      const settlement = await this.writeActionWithinLimit(ptyId, action, payload, guardedOptions)
      return acknowledgedPrefix && settlement?.outcome === 'refused'
        ? writeUnverifiable('partial_write', true)
        : settlement
    } catch (error) {
      if (acknowledgedPrefix) {
        return writeUnverifiable('partial_write', true)
      }
      throw error
    }
  }

  private async writeActionWithinLimit(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    // RPC/mobile text may be paste-sized; chunk for PTY/ConPTY without merging the suffix.
    const text = typeof action.text === 'string' ? action.text : ''
    const hasSuffix = action.enter || action.interrupt
    if (text) {
      const settlement = await this.writeChunks(ptyId, text, options)
      if (settlement && settlement.outcome !== 'accepted') {
        return settlement
      }
    }
    if (hasSuffix) {
      const suffix = (action.enter ? '\r' : '') + (action.interrupt ? '\x03' : '')
      const claimStartedAt = performance.now()
      // A shell at its prompt reads one line as typed; agent TUIs need the paste to settle.
      if (text && !(isSingleLine(text) && (await this.claimIdleShellPrompt(ptyId)))) {
        const delayMs = this.textSubmitDelay(ptyId, text).hostHeldMs
        // A failed idle proof already spent part of that wait, so a send is never slower than before.
        await waitForTerminalWriteDelay(
          Math.max(0, delayMs - (performance.now() - claimStartedAt)),
          options.signal
        )
      } else if (options.signal?.aborted) {
        // Match the settle path: a send cancelled during the idle proof must not submit.
        throw new Error('request_aborted')
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
      const settlement = await this.writeInput(ptyId, suffix, options)
      if (settlement && settlement.outcome !== 'accepted') {
        return settlement
      }
      await options.afterWrite?.(ptyId)
      return settlement
    }
    if (text) {
      return options.requireWriteSettlement ? WRITE_ACCEPTED : undefined
    }
    await options.beforeWrite?.(ptyId)
    options.reserveWrite?.(ptyId)
    const settlement = await this.writeInput(ptyId, payload, options)
    if (settlement && settlement.outcome !== 'accepted') {
      return settlement
    }
    await options.afterWrite?.(ptyId)
    return settlement
  }

  /** How long an Enter must trail `text` on this PTY. */
  textSubmitDelay(ptyId: string, text: string): ReturnType<typeof getTerminalTextSubmitDelay> {
    return getTerminalTextSubmitDelay(this.getWriteHostPlatform(ptyId), this.getAgent(ptyId), text)
  }

  async clientSubmitDelay(ptyId: string, text: string): Promise<number> {
    const platform = this.getWriteHostPlatform(ptyId)
    const agent = this.getAgent(ptyId)
    const base = getTerminalTextSubmitDelay(platform, agent, '').requiredMs
    let requiredMs = base
    // Round each bounded slice upward; split CRLFs and surrogate pairs only overestimate the wait.
    for (let start = 0; start < text.length; start += 16_384) {
      await yieldBetweenTerminalInputChunks()
      requiredMs +=
        getTerminalTextSubmitDelay(platform, agent, text.slice(start, start + 16_384)).requiredMs -
        base
    }
    return requiredMs
  }

  async writeChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    const chunks = iterateTerminalInputChunks(text)
    let chunk = chunks.next()
    while (!chunk.done) {
      await options.beforeWrite?.(ptyId)
      options.reserveWrite?.(ptyId)
      const settlement = await this.writeInput(ptyId, chunk.value, options)
      if (settlement && settlement.outcome !== 'accepted') {
        return settlement
      }
      await options.afterWrite?.(ptyId)
      chunk = chunks.next()
      if (!chunk.done) {
        await yieldBetweenTerminalInputChunks()
      }
    }
    return options.requireWriteSettlement ? WRITE_ACCEPTED : undefined
  }

  private async writeInput(
    ptyId: string,
    data: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    if (!options.requireWriteSettlement) {
      options.ownInput?.beforeWrite()
      const written = this.write(ptyId, data, options.inputKind)
      options.ownInput?.afterWrite()
      if (!written) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
      return undefined
    }
    if (!this.writeWithSettlement) {
      return writeRefused('provider_cannot_settle')
    }
    try {
      options.ownInput?.beforeWrite()
      const settlement = this.writeWithSettlement(ptyId, data, options.inputKind)
      // Before the await: the input is recorded when the write is handed off.
      options.ownInput?.afterWrite()
      return await settlement
    } catch {
      return writeUnverifiable('provider_threw_after_handoff', true)
    }
  }
}

function isSingleLine(text: string): boolean {
  return !text.includes('\n') && !text.includes('\r')
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
