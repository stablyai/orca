import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

/** Each row starts with the seq the spool wrote, so it is read without parsing the line. */
const ROW_SEQ = /^\{"seq":(\d+),/

/**
 * Rewrites the spool file with only rows after `acked`, so a file kept open across acks (lines kept
 * for a restart) never grows past what is still kept. Returns the file's size before and after.
 */
export async function compactSpoolFile(
  path: string,
  acked: number
): Promise<{ before: number; after: number }> {
  const contents = await readFile(path, 'utf8')
  const rows = contents.split('\n')
  const kept = rows.filter((row) => {
    const seq = ROW_SEQ.exec(row)
    return seq !== null && Number(seq[1]) > acked
  })
  const text = kept.length > 0 ? `${kept.join('\n')}\n` : ''
  const next = `${path}.compact`
  try {
    await writeFile(next, text, { mode: 0o600 })
    // Rename replaces the file in one step; a replay reading the old one keeps its open handle.
    await rename(next, path)
  } catch (error) {
    await unlink(next).catch(() => {})
    throw error
  }
  return { before: Buffer.byteLength(contents), after: Buffer.byteLength(text) }
}
