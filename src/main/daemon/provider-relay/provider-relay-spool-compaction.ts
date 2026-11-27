import { createReadStream } from 'node:fs'
import { open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { SPOOL_ROW_PREFIX_CHARS, SPOOL_ROW_SEQ } from './provider-relay-spool-row'

const READ_CHUNK_BYTES = 64 * 1024

/** Streams rows through, keeping those after `acked`; a row is never joined, however long. */
class RowFilter {
  bytes = 0
  /** Rows left out, so the spool can debit what each was charged beyond its bytes. */
  dropped = 0
  /** The start of a row too short yet to show its seq; written with the row once it is decided. */
  private undecided = ''
  private keep: boolean | null = null
  private rowStart = 0
  /** Output is written in batches, so a file of tiny rows isn't one write per row. */
  private buffered: string[] = []
  private bufferedChars = 0

  constructor(
    private readonly out: FileHandle,
    private readonly acked: number
  ) {}

  async piece(piece: string, endsRow: boolean): Promise<void> {
    let text = piece
    if (this.keep === null) {
      text = this.undecided + piece
      if (text.length < SPOOL_ROW_PREFIX_CHARS && !endsRow) {
        this.undecided = text
        return
      }
      this.undecided = ''
      const seq = SPOOL_ROW_SEQ.exec(text.slice(0, SPOOL_ROW_PREFIX_CHARS))
      this.keep = seq !== null && Number(seq[1]) > this.acked
      this.dropped += this.keep ? 0 : 1
    }
    if (this.keep && text.length > 0) {
      await this.write(text)
    }
    if (endsRow) {
      if (this.keep) {
        await this.write('\n')
      }
      this.keep = null
      this.rowStart = this.bytes
    }
  }

  /** A last row with no newline was torn by a failed write; what was written of it is cut off. */
  async end(): Promise<void> {
    await this.flush()
    if (this.bytes > this.rowStart) {
      await this.out.truncate(this.rowStart)
      this.bytes = this.rowStart
    }
  }

  private async write(text: string): Promise<void> {
    this.buffered.push(text)
    this.bufferedChars += text.length
    this.bytes += Buffer.byteLength(text)
    if (this.bufferedChars >= READ_CHUNK_BYTES) {
      await this.flush()
    }
  }

  private async flush(): Promise<void> {
    if (this.buffered.length > 0) {
      const text = this.buffered.join('')
      this.buffered = []
      this.bufferedChars = 0
      await this.out.appendFile(text)
    }
  }
}

/**
 * Rewrites the spool file with only rows after `acked`, so a file kept open across acks (lines kept
 * for a restart) never grows past what is still kept. It streams in chunks and yields between them,
 * so no file or row size holds the daemon's event loop. Returns the file's size before and after,
 * and how many rows it left out.
 */
export async function compactSpoolFile(
  path: string,
  acked: number
): Promise<{ before: number; after: number; dropped: number }> {
  const next = `${path}.compact`
  const out = await open(next, 'w', 0o600)
  const rows = new RowFilter(out, acked)
  let before = 0
  try {
    for await (const chunk of createReadStream(path, {
      encoding: 'utf8',
      highWaterMark: READ_CHUNK_BYTES
    })) {
      before += Buffer.byteLength(chunk)
      let start = 0
      let newline = chunk.indexOf('\n')
      while (newline !== -1) {
        await rows.piece(chunk.slice(start, newline), true)
        start = newline + 1
        newline = chunk.indexOf('\n', start)
      }
      await rows.piece(chunk.slice(start), false)
    }
    await rows.end()
    await out.close()
    await rename(next, path)
  } catch (error) {
    await out.close().catch(() => {})
    await unlink(next).catch(() => {})
    throw error
  }
  return { before, after: rows.bytes, dropped: rows.dropped }
}
