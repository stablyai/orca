import {
  BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES,
  type BrowserClientAutomationResult as BrowserClientHostCommandResult
} from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { BrowserError } from '../../../browser/browser-error'
import type {
  BrowserHostCommandPageState,
  BrowserHostCommandRecord,
  BrowserHostCommandResultChunkParams as ChunkParams
} from './browser-host-command-state'

// Several pages can stage at once; bound the lease's total, not just each result.
const MAX_STAGED_BYTES_PER_LEASE = 2 * BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES

type StagedResult = { chunks: Buffer[]; bytes: number }

/** Holds chunked automation results until the desktop settles their command. */
export class BrowserHostCommandResultStaging {
  private readonly staged = new Map<BrowserHostCommandRecord, StagedResult>()
  private bytes = 0

  append(
    page: BrowserHostCommandPageState | undefined,
    { pageHostGeneration, commandSequence, commandId, offset, contentBase64 }: ChunkParams
  ): void {
    const record =
      page?.generation === pageHostGeneration ? page.records.get(commandSequence) : undefined
    if (
      !record ||
      record.event.commandId !== commandId ||
      record.settled ||
      record.event.command.type !== 'automation' ||
      record.event.command.stagedResults !== true
    ) {
      throw new Error('browser_host_command_result_chunk_conflict')
    }
    if (offset === 0) {
      this.release(record)
    }
    const staged = this.staged.get(record) ?? { chunks: [], bytes: 0 }
    if (offset !== staged.bytes) {
      this.release(record)
      throw new Error('browser_host_command_result_chunk_out_of_order')
    }
    const chunk = Buffer.from(contentBase64, 'base64')
    if (chunk.byteLength === 0) {
      this.release(record)
      throw new Error('browser_host_command_result_chunk_invalid')
    }
    if (
      staged.bytes + chunk.byteLength > BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES ||
      this.bytes + chunk.byteLength > MAX_STAGED_BYTES_PER_LEASE
    ) {
      this.release(record)
      throw new BrowserError(
        'browser_host_command_result_too_large',
        'The server is already holding too many large browser results; retry, or use --format jpeg, a selector, or a smaller viewport.'
      )
    }
    staged.chunks.push(chunk)
    staged.bytes += chunk.byteLength
    this.bytes += chunk.byteLength
    this.staged.set(record, staged)
  }

  /** Swaps a staged marker for the value its chunks carried, and frees them either way. */
  take(
    record: BrowserHostCommandRecord,
    result: BrowserClientHostCommandResult
  ): BrowserClientHostCommandResult {
    const staged = this.staged.get(record)
    this.release(record)
    if (result.status !== 'completed' || result.stagedValueBytes === undefined) {
      return result
    }
    if (staged?.bytes !== result.stagedValueBytes) {
      return { status: 'failed', errorCode: 'browser_host_command_result_incomplete' }
    }
    try {
      return {
        status: 'completed',
        value: JSON.parse(Buffer.concat(staged.chunks).toString('utf8'))
      }
    } catch {
      return { status: 'failed', errorCode: 'browser_host_command_result_invalid' }
    }
  }

  release(record: BrowserHostCommandRecord): void {
    const staged = this.staged.get(record)
    if (staged) {
      this.bytes -= staged.bytes
      this.staged.delete(record)
    }
  }

  clear(): void {
    this.staged.clear()
    this.bytes = 0
  }
}
