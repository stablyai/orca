import { createReadStream } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'

/** Each row starts with the seq the spool wrote, so it is read without parsing the line. */
const ROW_SEQ = /^\{"seq":(\d+),/
const READ_CHUNK_BYTES = 64 * 1024

/**
 * Rewrites the spool file with only rows after `acked`, so a file kept open across acks (lines kept
 * for a restart) never grows past what is still kept. Streams it in chunks, yielding between them,
 * so a large file never holds the daemon's event loop. Returns the file's size before and after.
 */
export async function compactSpoolFile(
  path: string,
  acked: number
): Promise<{ before: number; after: number }> {
  const next = `${path}.compact`
  const out = await open(next, 'w', 0o600)
  let before = 0
  let after = 0
  const keep = async (rows: string[]): Promise<void> => {
    const kept = rows.filter((row) => {
      const seq = ROW_SEQ.exec(row)
      return seq !== null && Number(seq[1]) > acked
    })
    if (kept.length > 0) {
      const text = `${kept.join('\n')}\n`
      after += Buffer.byteLength(text)
      await out.appendFile(text)
    }
  }
  try {
    // A row longer than a chunk collects its parts and is joined once, not re-scanned per chunk.
    let parts: string[] = []
    for await (const chunk of createReadStream(path, {
      encoding: 'utf8',
      highWaterMark: READ_CHUNK_BYTES
    })) {
      before += Buffer.byteLength(chunk)
      const newline = chunk.indexOf('\n')
      if (newline === -1) {
        parts.push(chunk)
        continue
      }
      const rows = chunk.slice(newline + 1).split('\n')
      const first = parts.join('') + chunk.slice(0, newline)
      parts = [rows.pop() ?? '']
      await keep([first, ...rows])
    }
    // A last row with no newline was torn by a failed write and is dropped.
    await out.close()
    await rename(next, path)
  } catch (error) {
    await out.close().catch(() => {})
    await unlink(next).catch(() => {})
    throw error
  }
  return { before, after }
}
