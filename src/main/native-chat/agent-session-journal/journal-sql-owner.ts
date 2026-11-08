import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type { JournalSqlRequest, JournalSqlResponse } from './journal-sql-protocol'
import { restoreJournalSqlFailure } from './journal-sql-failure'
import { prepareJournalSqlRequest } from './journal-sql-ready-batch'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit } from './journal-writer-changes'
import type { JournalWriterEffect, JournalWriterEffectResult } from './journal-writer-effects'
import type { JournalSqlMaintenance, JournalSqlMaintenanceResult } from './journal-sql-maintenance'
import {
  prepareJournalSqlMessages,
  type JournalSqlMessagesCommit
} from './journal-sql-message-commit'

export class JournalIndeterminateWriteError extends Error {
  override readonly name = 'JournalIndeterminateWriteError'
}

/** A lost acknowledgement never authorizes replay; close waits for the owned worker's observed exit. */
export class JournalSqlOwner {
  private readonly worker: Worker
  private readonly ready = Promise.withResolvers<boolean>()
  private readonly exited = Promise.withResolvers<void>()
  private readonly pending = new Map<
    number,
    {
      resolve: (response: JournalSqlResponse) => void
      reject: (error: Error) => void
      write: boolean
    }
  >()
  private nextId = 0
  private failure: Error | undefined
  private closing = false
  private didExit = false
  private closed: Promise<void> | undefined
  onFault: (error: Error) => void = () => {}

  constructor(
    filename: string,
    stateDirectory: string,
    workerPath = resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'journal-sql-worker-entry.js'
    )
  ) {
    this.worker = spawnWorkerThread(workerPath, {
      workerData: { filename, stateDirectory },
      execArgv: []
    })
    this.worker.on('message', (response: JournalSqlResponse) => this.receive(response))
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

  async write(command: JournalWriterCommand): Promise<JournalWriterCommit> {
    const response = await this.request({ type: 'write', command })
    if (response.type !== 'committed') {
      throw new Error('journal writer returned no commit')
    }
    return response.commit
  }

  async messages(
    command: Parameters<typeof prepareJournalSqlMessages>[0]
  ): Promise<JournalSqlMessagesCommit> {
    const response = await this.request({
      type: 'messages',
      job: prepareJournalSqlMessages(command)
    })
    if (response.type !== 'messages') {
      throw new Error('journal writer returned no message commit')
    }
    return response.commit
  }

  async effects(effects: readonly JournalWriterEffect[]): Promise<JournalWriterEffectResult[]> {
    const response = await this.request({ type: 'effects', effects })
    if (response.type !== 'effects') {
      throw new Error('journal writer returned no effects')
    }
    return response.results
  }

  async maintain(operation: JournalSqlMaintenance): Promise<JournalSqlMaintenanceResult> {
    const response = await this.request({ type: 'maintenance', operation })
    if (response.type !== 'maintenance') {
      throw new Error('journal writer returned no maintenance result')
    }
    return response.result
  }

  close(): Promise<void> {
    this.closed ??= this.finishClose().catch((error: unknown) => {
      this.closed = undefined
      throw error
    })
    return this.closed
  }

  private request(command: JournalSqlRequest['command']): Promise<JournalSqlResponse> {
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
        write:
          command.type !== 'close' &&
          !(command.type === 'maintenance' && command.operation.kind === 'projection-state')
      })
      try {
        this.worker.postMessage(prepareJournalSqlRequest(id, command))
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private async finishClose(): Promise<void> {
    this.closing = true
    if (this.failure && !this.didExit) {
      await this.worker.terminate()
    } else if (!this.didExit) {
      await this.request({ type: 'close' })
    }
    await this.exited.promise
  }

  private receive(response: JournalSqlResponse): void {
    if (response.type === 'ready') {
      this.ready.resolve(response.readOnly)
      return
    }
    const pending = response.id === undefined ? undefined : this.pending.get(response.id)
    if (response.id !== undefined) {
      this.pending.delete(response.id)
    }
    if (response.type === 'failed') {
      const cause = restoreJournalSqlFailure(response.error)
      pending?.reject(
        response.outcome === 'indeterminate'
          ? new JournalIndeterminateWriteError('journal commit outcome is unknown', { cause })
          : cause
      )
      if (response.fatal || response.id === undefined) {
        this.fail(cause)
      }
      return
    }
    pending?.resolve(response)
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
