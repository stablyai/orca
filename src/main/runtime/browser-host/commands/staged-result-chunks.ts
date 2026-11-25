import { BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { BrowserError } from '../../../browser/browser-error'

type StagedResult = { chunks: Buffer[]; bytes: number }

export type TakenStagedResult = { ok: true; value: unknown } | { ok: false; errorCode: string }

/** Holds a result's JSON chunks, sent ahead of its settlement, until the sender settles it. */
export class StagedResultChunks<Key> {
  private readonly staged = new Map<Key, StagedResult>()
  private bytes = 0

  /** Several results can stage at once; bound their total, not just each one. */
  constructor(private readonly maxTotalBytes: number) {}

  append(key: Key, offset: number, contentBase64: string): void {
    if (offset === 0) {
      this.release(key)
    }
    const staged = this.staged.get(key) ?? { chunks: [], bytes: 0 }
    if (offset !== staged.bytes) {
      this.release(key)
      throw new Error('browser_host_command_result_chunk_out_of_order')
    }
    const chunk = Buffer.from(contentBase64, 'base64')
    if (chunk.byteLength === 0) {
      this.release(key)
      throw new Error('browser_host_command_result_chunk_invalid')
    }
    if (
      staged.bytes + chunk.byteLength > BROWSER_CLIENT_AUTOMATION_STAGED_RESULT_MAX_BYTES ||
      this.bytes + chunk.byteLength > this.maxTotalBytes
    ) {
      this.release(key)
      throw new BrowserError(
        'browser_host_command_result_too_large',
        'The server is already holding too many large browser results; retry, or use --format jpeg, a selector, or a smaller viewport.'
      )
    }
    staged.chunks.push(chunk)
    staged.bytes += chunk.byteLength
    this.bytes += chunk.byteLength
    this.staged.set(key, staged)
  }

  /** The value the chunks carried, if they add up to the settled size; frees them either way. */
  take(key: Key, expectedBytes: number): TakenStagedResult {
    const staged = this.staged.get(key)
    this.release(key)
    if (staged?.bytes !== expectedBytes) {
      return { ok: false, errorCode: 'browser_host_command_result_incomplete' }
    }
    try {
      return { ok: true, value: JSON.parse(Buffer.concat(staged.chunks).toString('utf8')) }
    } catch {
      return { ok: false, errorCode: 'browser_host_command_result_invalid' }
    }
  }

  release(key: Key): void {
    const staged = this.staged.get(key)
    if (staged) {
      this.bytes -= staged.bytes
      this.staged.delete(key)
    }
  }

  clear(): void {
    this.staged.clear()
    this.bytes = 0
  }
}
