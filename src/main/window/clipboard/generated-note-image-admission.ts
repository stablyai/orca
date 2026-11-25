import { promisify } from 'node:util'
import { inflate } from 'node:zlib'
import { generatedNoteImageLayout } from '../../../shared/native-chat/media-notes/generated-note-image'

/** Whether `bytes` is a whole notes PNG whose image data decodes to exactly its rows: complete
 *  chunks (see `generatedNoteImageLayout`), then a zlib stream that is neither cut off nor longer
 *  than the image, with a valid filter byte on every row. */
const inflateAsync = promisify(inflate)

export async function isAdmissibleGeneratedNoteImage(bytes: unknown): Promise<boolean> {
  const layout = generatedNoteImageLayout(bytes)
  if (!layout) {
    return false
  }
  let raw: Buffer
  try {
    // Bounded by the image's own size, so a small stream can't expand into a large allocation; off
    // the main thread, on libuv's pool.
    raw = await inflateAsync(Buffer.concat(layout.data), { maxOutputLength: layout.rawByteLength })
  } catch {
    return false
  }
  if (raw.length !== layout.rawByteLength) {
    return false
  }
  const rowLength = layout.rawByteLength / layout.height
  for (let row = 0; row < raw.length; row += rowLength) {
    if (raw[row] > 4) {
      return false
    }
  }
  return true
}

// One notes image is checked and saved at a time, across every window: at most one decoded check and
// one write are in flight however many viewers send at once.
let saves: Promise<unknown> = Promise.resolve()

/** Runs `work` after every earlier notes-image save has finished. */
export function queueGeneratedNoteImageSave<T>(work: () => Promise<T>): Promise<T> {
  const run = saves.then(work)
  saves = run.catch(() => undefined)
  return run
}
