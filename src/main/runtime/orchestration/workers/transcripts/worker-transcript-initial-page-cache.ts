import type { NativeChatLineDecoder } from '../../../../native-chat/transcript-tail-reader'
import { readLocalTranscriptSourceIdentity } from './worker-transcript-local-checkpoint'
import { readInitialLocalWorkerTranscriptPage } from './worker-transcript-local-read'

type InitialPage = Awaited<ReturnType<typeof readInitialLocalWorkerTranscriptPage>>

// A few transcripts are followed at once; each entry holds one bounded page.
const MAX_ENTRIES = 16

/** Latest pages of transcripts nobody has written since: a repeated first read reuses the answer
 *  and simultaneous readers share one scan. Keyed by the file's identity (device, inode, size,
 *  mtime), so any write misses and rescans; a failed read is never kept. */
const pages = new Map<string, { decode: NativeChatLineDecoder; page: Promise<InitialPage> }>()

export async function readInitialLocalWorkerTranscriptPageReusing(
  filePath: string,
  limit: number,
  decode: NativeChatLineDecoder
): Promise<InitialPage> {
  const identity = await readLocalTranscriptSourceIdentity(filePath)
  if (!identity) {
    return { ok: false, reason: 'transcript_unreadable', warnings: [] }
  }
  const key = [filePath, identity.fingerprint, identity.size, identity.mtimeMs, limit].join('\0')
  const cached = pages.get(key)
  if (cached?.decode === decode) {
    pages.delete(key)
    pages.set(key, cached)
    return cached.page
  }
  const page = readInitialLocalWorkerTranscriptPage(filePath, limit, decode)
  pages.set(key, { decode, page })
  const oldest = pages.keys().next().value
  if (pages.size > MAX_ENTRIES && oldest !== undefined) {
    pages.delete(oldest)
  }
  const result = await page.catch((error: unknown) => {
    pages.delete(key)
    throw error
  })
  if (!result.ok && pages.get(key)?.page === page) {
    pages.delete(key)
  }
  return result
}
