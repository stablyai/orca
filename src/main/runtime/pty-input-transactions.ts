import { KeyedOperationQueue } from './keyed-operation-queue'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'
import {
  isSettledWrite,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'

// Above the daemon's 5 s and SSH's 60 s settlement bounds.
export const PTY_INPUT_EXTERNAL_AWAIT_TIMEOUT_MS = 90_000

export type PtyInputBinding = { key: string; isCurrent: () => boolean }

export function ptyInputTransactionKey(ptyId: string): string {
  return ptyId
}

export class PtyInputPreemptedError extends Error {
  constructor(readonly bytesHandedToTransport: boolean) {
    super(bytesHandedToTransport ? 'partial_write' : 'request_aborted')
  }
}

export class PtyInputAbandonedError extends Error {
  constructor(readonly bytesHandedToTransport: boolean) {
    super(bytesHandedToTransport ? 'partial_write' : 'request_timeout')
  }
}

export type PtyInputWriter = {
  write: (data: string, inputKind: TerminalInputKind, transaction: PtyInputTransaction) => boolean
  writeWithSettlement?: (
    data: string,
    inputKind: TerminalInputKind,
    transaction: PtyInputTransaction
  ) => WriteSettlement | Promise<WriteSettlement>
}

export type PtyInputTransactionOptions = {
  signal?: AbortSignal
  deadlineAt?: number
  interrupt?: boolean
  rawInput?: boolean
  writer?: PtyInputWriter
}

export class PtyInputTransaction {
  private handedOff = false
  private stopped: PtyInputPreemptedError | PtyInputAbandonedError | undefined
  private readonly stop = new AbortController()
  private byteCount = 0

  constructor(
    private readonly binding: PtyInputBinding,
    private readonly signal?: AbortSignal,
    private readonly requestDeadlineAt?: number,
    private readonly writer?: PtyInputWriter
  ) {}

  get stopSignal(): AbortSignal {
    return this.stop.signal
  }

  get bytesWritten(): number {
    return this.byteCount
  }

  get bytesHandedToTransport(): boolean {
    return this.handedOff
  }

  awaitExternal<T>(operation: () => T | Promise<T>): T | Promise<T> {
    this.assertRunning()
    const result = operation()
    if (!(result instanceof Promise)) {
      return result
    }
    return new Promise<T>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        this.stopSignal.removeEventListener('abort', onStop)
      }
      const onStop = (): void => {
        cleanup()
        reject(this.stopped)
      }
      const timer = setTimeout(() => {
        if (!this.stopped) {
          this.stopped = new PtyInputAbandonedError(this.handedOff)
          console.warn('[pty] input external await timed out:', this.binding.key)
          this.stop.abort(this.stopped)
        }
      }, PTY_INPUT_EXTERNAL_AWAIT_TIMEOUT_MS)
      this.stopSignal.addEventListener('abort', onStop, { once: true })
      result.then(
        (value) => {
          cleanup()
          if (this.stopped) {
            reject(this.stopped)
          } else {
            resolve(value)
          }
        },
        (error) => {
          cleanup()
          reject(this.stopped ?? error)
        }
      )
      if (this.stopSignal.aborted) {
        onStop()
      }
    })
  }

  preempt(): void {
    if (!this.stopped) {
      this.stopped = new PtyInputPreemptedError(this.handedOff)
      this.stop.abort(this.stopped)
    }
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw this.stopped
    }
  }

  beforeWrite(): void {
    this.assertRunning()
    if (!this.binding.isCurrent()) {
      throw new Error('terminal_not_writable')
    }
    if (!this.handedOff && this.signal?.aborted) {
      throw new Error('request_aborted')
    }
    if (
      !this.handedOff &&
      this.requestDeadlineAt !== undefined &&
      Date.now() >= this.requestDeadlineAt
    ) {
      throw new Error('request_timeout')
    }
  }

  handoff(): void {
    this.beforeWrite()
    this.handedOff = true
  }

  write(data: string, inputKind: TerminalInputKind): boolean {
    if (!this.writer) {
      throw new Error('terminal_not_writable')
    }
    const previousHandoff = this.handedOff
    this.handoff()
    this.byteCount += Buffer.byteLength(data, 'utf8')
    const accepted = this.writer.write(data, inputKind, this)
    if (!accepted) {
      this.byteCount -= Buffer.byteLength(data, 'utf8')
      this.handedOff = previousHandoff
    }
    return accepted
  }

  writeWithSettlement(
    data: string,
    inputKind: TerminalInputKind
  ): WriteSettlement | Promise<WriteSettlement> {
    const settledWrite = this.writer?.writeWithSettlement
    if (!settledWrite) {
      return writeRefused('provider_cannot_settle')
    }
    const previousHandoff = this.handedOff
    this.handoff()
    const byteLength = Buffer.byteLength(data, 'utf8')
    this.byteCount += byteLength
    const settle = (result: WriteSettlement): WriteSettlement => {
      if (result.outcome === 'refused') {
        this.byteCount -= byteLength
        this.handedOff = previousHandoff
      }
      return result
    }
    const result = this.awaitExternal(() => {
      try {
        const settlement = settledWrite(data, inputKind, this)
        return isSettledWrite(settlement)
          ? settlement
          : settlement.catch(() => writeUnverifiable('provider_threw_after_handoff', true))
      } catch {
        return writeUnverifiable('provider_threw_after_handoff', true)
      }
    })
    return isSettledWrite(result) ? settle(result) : result.then(settle)
  }
}

export class PtyInputTransactions {
  private readonly queue = new KeyedOperationQueue()

  get size(): number {
    return this.queue.size
  }

  run<T>(
    binding: PtyInputBinding,
    operation: (transaction: PtyInputTransaction) => T | Promise<T>,
    options: PtyInputTransactionOptions = {}
  ): T | Promise<T> {
    let transaction: PtyInputTransaction | undefined
    return this.queue.run(
      binding.key,
      () => {
        transaction = new PtyInputTransaction(
          binding,
          options.signal,
          options.deadlineAt,
          options.writer
        )
        transaction.beforeWrite()
        return operation(transaction)
      },
      {
        signal: options.signal,
        deadlineAt: options.deadlineAt,
        priority: options.interrupt,
        rawInput: options.rawInput,
        preempt: () => transaction?.preempt()
      }
    )
  }
}

export const ptyInputTransactions = new PtyInputTransactions()
