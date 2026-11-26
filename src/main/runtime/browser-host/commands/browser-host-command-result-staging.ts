import {
  BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES,
  type BrowserClientAutomationResult as BrowserClientHostCommandResult
} from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type {
  BrowserHostCommandPageState,
  BrowserHostCommandRecord,
  BrowserHostCommandResultChunkParams as ChunkParams
} from './browser-host-command-state'
import { StagedResultChunks } from './staged-result-chunks'

// Several pages can stage at once; bound the lease's total, not just each result.
const MAX_STAGED_BYTES_PER_LEASE = 2 * BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES

/** Holds chunked automation results until the desktop settles their command. */
export class BrowserHostCommandResultStaging {
  private readonly chunks = new StagedResultChunks<BrowserHostCommandRecord>(
    MAX_STAGED_BYTES_PER_LEASE
  )

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
    this.chunks.append(record, offset, contentBase64)
  }

  /** Swaps a staged marker for the value its chunks carried, and frees them either way. */
  take(
    record: BrowserHostCommandRecord,
    result: BrowserClientHostCommandResult
  ): BrowserClientHostCommandResult {
    if (result.status !== 'completed' || result.stagedValueBytes === undefined) {
      this.chunks.release(record)
      return result
    }
    const taken = this.chunks.take(record, result.stagedValueBytes)
    return taken.ok
      ? { status: 'completed', value: taken.value }
      : { status: 'failed', errorCode: taken.errorCode }
  }

  release(record: BrowserHostCommandRecord): void {
    this.chunks.release(record)
  }

  clear(): void {
    this.chunks.clear()
  }
}
