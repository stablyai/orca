import { journalTransferBatches, receiveJournalResult } from './journal-unit-transfer'
import type { JournalEffectResult } from './journal-persistence-plan'
import { Worker } from 'node:worker_threads'
import type { SQLInputValue } from 'node:sqlite'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import {
  restoreJournalSqlFailure,
  type JournalSqlCommand,
  type JournalSqlResponse,
  type JournalRead,
  type JournalReadResult
} from './journal-sql-protocol'
import type { CommandReceiptScope } from './command-receipt-schema'
import type { CommandReceiptRead } from './command-receipt-table'
import type { JournalOutcomeSource } from './journal-outcome-format'

export class JournalIndeterminateWriteError extends Error {
  override readonly name = 'JournalIndeterminateWriteError'
}

/** Correlation and observed exit only: a lost write acknowledgement never authorizes replay. */
export class JournalSqlOwner {
  private readonly worker: Worker
  private readonly ready = Promise.withResolvers<boolean>()
  private readonly exited = Promise.withResolvers<void>()
  private readonly pending = new Map<
    number,
    {
      resolve: (reply: JournalSqlResponse) => void
      reject: (error: Error) => void
      write: boolean
      results: JournalEffectResult[]
      resultCount?: number
    }
  >()
  private nextId = 0
  private failure: Error | undefined
  private closing = false
  private closed: Promise<void> | undefined
  private didExit = false
  readonly connection: JournalReadConnection
  onFault: (error: Error) => void = () => {}

  constructor(filename: string, options: { reader?: boolean; workerPath?: string } = {}) {
    this.worker = new Worker(
      options.workerPath ??
        resolveWorkerThreadEntryPath(
          currentWorkerEntryLayout(__dirname),
          'journal-sql-worker-entry.js'
        ),
      { workerData: { filename, reader: options.reader }, execArgv: [] }
    )
    this.connection = new JournalReadConnection(async (read) => {
      const reply = await this.request({ type: 'read', read })
      if (reply.type !== 'read') {
        throw new Error('journal reader returned an invalid result')
      }
      return reply.result
    })
    this.worker.on('message', (reply: JournalSqlResponse) => {
      try {
        this.receive(reply)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.once('exit', (code) => {
      this.didExit = true
      this.exited.resolve()
      if (!this.closing || this.pending.size > 0) {
        this.fail(new Error(`journal SQL owner exited (${code})`))
      }
    })
  }

  opened(): Promise<boolean> {
    return this.ready.promise
  }

  request(command: JournalSqlCommand): Promise<JournalSqlResponse> {
    if (this.closing && command.type !== 'close') {
      return Promise.reject(new Error('journal SQL owner is closing'))
    }
    if (this.failure || this.didExit) {
      return Promise.reject(this.failure ?? new Error('journal SQL owner exited'))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        write: command.type === 'unit' || command.type === 'maintenance',
        results: [],
        resultCount: command.type === 'unit' ? command.count : undefined
      })
      try {
        this.worker.postMessage({ id, command })
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  close(): Promise<void> {
    this.closed ??= this.finishClose().catch((error: unknown) => {
      this.closed = undefined
      throw error
    })
    return this.closed
  }
  private async finishClose(): Promise<void> {
    this.closing = true
    if (this.failure && !this.didExit) {
      await this.worker.terminate()
    } else if (!this.didExit) {
      try {
        await this.request({ type: 'close' })
      } catch (error) {
        this.closing = false
        throw error
      }
    }
    await this.exited.promise
  }
  private receive(reply: JournalSqlResponse): void {
    if (reply.type === 'ready') {
      this.ready.resolve(reply.readOnly)
      return
    }
    if (reply.type === 'failed' && reply.id === undefined) {
      this.fail(restoreJournalSqlFailure(reply.error))
      return
    }
    if (reply.id === undefined) {
      return
    }
    const pending = this.pending.get(reply.id)
    if (reply.type === 'results') {
      if (pending) {
        for (const packet of reply.packets) {
          if (!packet || pending.resultCount === undefined || packet.index >= pending.resultCount) {
            throw new Error('Unexpected journal result packet')
          }
          receiveJournalResult(pending.results, packet)
        }
      }
      return
    }
    if (
      reply.type === 'committed' &&
      (!pending || pending.results.length !== pending.resultCount)
    ) {
      throw new Error('Journal committed result is incomplete')
    }
    this.pending.delete(reply.id)
    if (reply.type === 'failed') {
      const cause = restoreJournalSqlFailure(reply.error)
      pending?.reject(
        reply.outcome === 'indeterminate'
          ? new JournalIndeterminateWriteError('journal commit outcome is unknown', { cause })
          : cause
      )
      if (reply.fatal) {
        this.fail(cause)
      }
    } else {
      pending?.resolve(reply.type === 'committed' ? { ...reply, values: pending.results } : reply)
    }
  }
  private fail(error: Error): void {
    if (this.failure) {
      return
    }
    this.failure = error
    this.ready.reject(error)
    for (const pending of this.pending.values()) {
      pending.reject(
        pending.write
          ? new JournalIndeterminateWriteError(
              'journal owner exited before write acknowledgement',
              { cause: error }
            )
          : error
      )
    }
    this.pending.clear()
    this.onFault(error)
  }
}

/** Read-only native values; repeated key lookups use bounded request batches. */
export class JournalReadConnection {
  constructor(private readonly request: (read: JournalRead) => Promise<JournalReadResult>) {}
  prepare(sql: string) {
    const rows = async (parameters: SQLInputValue[], one: boolean): Promise<SqliteRow[]> => {
      const rows: SqliteRow[] = []
      for await (const page of this.pages(sql, parameters, one)) {
        rows.push(...page)
      }
      return rows
    }
    return {
      all: (...parameters: SQLInputValue[]) => rows(parameters, false),
      get: async (...parameters: SQLInputValue[]): Promise<SqliteRow | undefined> =>
        (await rows(parameters, true))[0]
    }
  }
  async *pages(sql: string, parameters: SQLInputValue[], one = false): AsyncGenerator<SqliteRow[]> {
    let token: number | undefined
    try {
      let result = await this.request({ kind: 'sql', sql, parameters, one })
      for (;;) {
        if (result.kind !== 'rows') {
          throw new Error('journal reader returned no rows')
        }
        token = result.token
        yield result.rows
        if (token === undefined) {
          return
        }
        result = await this.request({ kind: 'page', token })
      }
    } finally {
      if (token !== undefined) {
        await this.request({ kind: 'release', token })
      }
    }
  }
  async outcomes(
    generation: number,
    through: number,
    field: string,
    key: string
  ): Promise<SqliteRow[]> {
    const result = await this.request({ kind: 'outcomes', generation, through, field, key })
    if (result.kind !== 'rows') {
      throw new Error('journal outcome page is incomplete')
    }
    return result.rows
  }
  async source(sessionId: string, epoch: string): Promise<JournalOutcomeSource | null> {
    const result = await this.request({ kind: 'source', sessionId, epoch })
    if (result.kind !== 'source') {
      throw new Error('journal reader returned no source')
    }
    return result.source
  }
  async receipts(
    scope: CommandReceiptScope,
    ids: readonly string[]
  ): Promise<Map<string, CommandReceiptRead>> {
    const values = new Map<string, CommandReceiptRead>()
    for (const page of journalTransferBatches(ids)) {
      let offset = 0
      while (offset < page.length) {
        const result = await this.request({ kind: 'receipts', scope, ids: page.slice(offset) })
        if (
          result.kind !== 'receipts' ||
          result.receipts.length === 0 ||
          result.receipts.length > page.length - offset
        ) {
          throw new Error('journal receipt batch is incomplete')
        }
        result.receipts.forEach((receipt, index) => values.set(page[offset + index]!, receipt))
        offset += result.receipts.length
      }
    }
    return values
  }
  async probe(): Promise<boolean> {
    const result = await this.request({ kind: 'probe' })
    if (result.kind !== 'probe') {
      throw new Error('journal reader returned no probe')
    }
    return result.present
  }
}
