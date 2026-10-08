import { resolveAgentPromptSubmitDelayForAgent } from '../../shared/agent-prompt-injection'
import type { TerminalAgent } from '../../shared/terminal-agent'
import { iterateTerminalInputChunks } from '../../shared/terminal-input'
import { isTerminalQueryReply } from '../../shared/terminal-query-reply'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
import {
  PtyInputAbandonedError,
  PtyInputPreemptedError,
  PtyInputTransactions,
  ptyInputTransactionKey,
  type PtyInputBinding,
  PtyInputTransaction,
  type PtyInputWriter
} from './pty-input-transactions'

import {
  waitForAgentPromptDelay as waitForTerminalWriteDelay,
  yieldBetweenTerminalInputChunks
} from './orca-runtime-core'

export type RuntimeTerminalWriteOptions = {
  inputKind: TerminalInputKind
  signal?: AbortSignal
  deadlineAt?: number
  beforeWrite?: ((ptyId: string) => void | Promise<void>) & { revalidate?: (ptyId: string) => void }
  reserveWrite?: (ptyId: string) => void
  afterWrite?: (ptyId: string) => void | Promise<void>
  suffixFailureError?: string
  requireWriteSettlement?: true
  transaction?: PtyInputTransaction
  binding?: PtyInputBinding
  rawInput?: boolean
  onBytesWritten?: (bytes: number) => void
}

export class RuntimeTerminalWriter {
  constructor(
    private readonly write: (
      ptyId: string,
      data: string,
      inputKind: TerminalInputKind,
      transaction?: PtyInputTransaction
    ) => boolean,
    private readonly getWriteHostPlatform: (ptyId: string) => NodeJS.Platform = () =>
      process.platform,
    private readonly getAgent: (ptyId: string) => TerminalAgent | null = () => null,
    private readonly writeWithSettlement?: (
      ptyId: string,
      data: string,
      inputKind: TerminalInputKind,
      transaction?: PtyInputTransaction
    ) => WriteSettlement | Promise<WriteSettlement>,
    private readonly bindInput: (ptyId: string) => PtyInputBinding = (ptyId) => ({
      key: ptyInputTransactionKey(ptyId),
      isCurrent: () => true
    }),
    private readonly transactions = new PtyInputTransactions()
  ) {}

  async writeAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    const execute = (transaction: PtyInputTransaction) => {
      const initialByteCount = transaction.bytesWritten
      const text = action.text ?? ''
      const submitDelayMs =
        text && (action.enter || action.interrupt)
          ? resolveAgentPromptSubmitDelayForAgent(
              this.getWriteHostPlatform(ptyId),
              text,
              this.getAgent(ptyId)
            )
          : 0
      return this.writeActionInTransaction(
        ptyId,
        action,
        payload,
        { ...options, transaction },
        submitDelayMs
      ).finally(() => options.onBytesWritten?.(transaction.bytesWritten - initialByteCount))
    }
    const settledWrite = this.writeWithSettlement
    const writer: PtyInputWriter = {
      write: (data, kind, transaction) => this.write(ptyId, data, kind, transaction),
      ...(settledWrite
        ? {
            writeWithSettlement: (data, kind, transaction) =>
              settledWrite(ptyId, data, kind, transaction)
          }
        : {})
    }
    if (options.transaction) {
      return execute(options.transaction)
    }
    if (options.inputKind === 'query-reply' && isTerminalQueryReply(payload)) {
      return execute(
        new PtyInputTransaction(
          { key: ptyInputTransactionKey(ptyId), isCurrent: () => true },
          undefined,
          undefined,
          writer
        )
      )
    }
    try {
      return await this.transactions.run(options.binding ?? this.bindInput(ptyId), execute, {
        signal: options.signal,
        deadlineAt: options.deadlineAt,
        interrupt: payload === '\x03',
        rawInput: options.rawInput || payload === '\x03',
        writer
      })
    } catch (error) {
      if (
        (error instanceof PtyInputAbandonedError || error instanceof PtyInputPreemptedError) &&
        error.bytesHandedToTransport
      ) {
        return writeUnverifiable('partial_write', true)
      }
      throw error
    }
  }

  private async writeActionInTransaction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions,
    submitDelayMs = 0
  ): Promise<WriteSettlement | undefined> {
    let acknowledgedPrefix = false
    const guardedOptions = {
      ...options,
      signal: undefined,
      afterWrite: (id: string): void | Promise<void> => {
        acknowledgedPrefix = true
        return options.afterWrite?.(id)
      }
    }
    try {
      const settlement = await this.writeActionWithinLimit(
        ptyId,
        action,
        payload,
        guardedOptions,
        submitDelayMs
      )
      return acknowledgedPrefix && settlement?.outcome === 'refused'
        ? writeUnverifiable('partial_write', true)
        : settlement
    } catch (error) {
      if (acknowledgedPrefix || options.transaction?.bytesHandedToTransport) {
        return writeUnverifiable('partial_write', true)
      }
      throw error
    }
  }

  private async writeActionWithinLimit(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions,
    submitDelayMs: number
  ): Promise<WriteSettlement | undefined> {
    // Why: direct terminal.send can carry paste-sized text from RPC/mobile
    // clients; chunk text before PTY/ConPTY while preserving suffix separation.
    const text = typeof action.text === 'string' ? action.text : ''
    const hasSuffix = action.enter || action.interrupt
    if (text) {
      const settlement = await this.writeChunksInTransaction(ptyId, text, options)
      if (settlement && settlement.outcome !== 'accepted') {
        return settlement
      }
    }
    if (hasSuffix) {
      const suffix = (action.enter ? '\r' : '') + (action.interrupt ? '\x03' : '')
      if (text) {
        // Why: same hazard as the agent-prompt path -- Enter must not overtake text the
        // execution host is still ingesting, and a flat 500 ms cannot cover 16 MB.
        await waitForTerminalWriteDelay(
          submitDelayMs,
          options.transaction?.stopSignal ?? options.signal
        )
      }
      try {
        await this.awaitCallback(options, () => options.beforeWrite?.(ptyId))
      } catch (error) {
        if (options.suffixFailureError) {
          throw new Error(options.suffixFailureError)
        }
        throw error
      }
      options.transaction?.beforeWrite()
      options.reserveWrite?.(ptyId)
      const settlement = await this.writeInput(ptyId, suffix, options)
      if (settlement && settlement.outcome !== 'accepted') {
        return settlement
      }
      await this.awaitCallback(options, () => options.afterWrite?.(ptyId))
      return settlement
    }
    if (text) {
      return options.requireWriteSettlement ? WRITE_ACCEPTED : undefined
    }
    await this.awaitCallback(options, () => options.beforeWrite?.(ptyId))
    options.transaction?.beforeWrite()
    options.reserveWrite?.(ptyId)
    const settlement = await this.writeInput(ptyId, payload, options)
    if (settlement && settlement.outcome !== 'accepted') {
      return settlement
    }
    await this.awaitCallback(options, () => options.afterWrite?.(ptyId))
    return settlement
  }

  async writeChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    return this.writeAction(ptyId, { text }, text, options)
  }

  private async writeChunksInTransaction(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions
  ): Promise<WriteSettlement | undefined> {
    const chunks = iterateTerminalInputChunks(text)
    let chunk = chunks.next()
    while (!chunk.done) {
      await this.awaitCallback(options, () => options.beforeWrite?.(ptyId))
      options.transaction?.beforeWrite()
      options.reserveWrite?.(ptyId)
      const settlement = await this.writeInput(ptyId, chunk.value, options)
      if (settlement && settlement.outcome !== 'accepted') {
        return settlement
      }
      await this.awaitCallback(options, () => options.afterWrite?.(ptyId))
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
      const accepted = options.transaction
        ? options.transaction.write(data, options.inputKind)
        : this.write(ptyId, data, options.inputKind)
      if (!accepted) {
        throw new Error(options.suffixFailureError ?? 'terminal_not_writable')
      }
      return undefined
    }
    if (!this.writeWithSettlement) {
      return writeRefused('provider_cannot_settle')
    }
    try {
      return await (options.transaction
        ? options.transaction.writeWithSettlement(data, options.inputKind)
        : this.writeWithSettlement(ptyId, data, options.inputKind))
    } catch (error) {
      if (error instanceof PtyInputPreemptedError || error instanceof PtyInputAbandonedError) {
        throw error
      }
      return writeUnverifiable('provider_threw_after_handoff', true)
    }
  }

  private awaitCallback(
    options: RuntimeTerminalWriteOptions,
    callback: () => void | Promise<void>
  ): void | Promise<void> {
    return options.transaction ? options.transaction.awaitExternal(callback) : callback()
  }
}
