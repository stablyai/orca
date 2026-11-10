import {
  SessionSearchCatalogClient,
  type SessionSearchCatalogRequest
} from './session-search-catalog-client'
import type { SessionDiscoveryDependencyObserver } from '../ai-vault/session-discovery-context'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { isMissingTranscriptPathError } from '../ai-vault/session-file-observation'
import { consumeCompleteJsonlLines } from '../ai-vault/session-scanner-jsonl-reader'
import {
  canAppendSessionIndexJsonl,
  firstRecordSignature,
  type SessionIndexJsonlCursor
} from '../ai-vault/session-index-jsonl-read'

/** Search accepts its own input cursor and keyed values without retaining a second title archive. */
export function createSessionSearchJsonlDependency(
  path: string,
  parse: (line: string) => readonly [string, string] | null,
  owner: { request: SessionSearchCatalogRequest; scope: string }
): SessionDiscoveryDependencyObserver {
  const accepted = new SessionSearchCatalogClient<string>(`${owner.scope}:accepted`, owner.request)
  const staging = new SessionSearchCatalogClient<string>(`${owner.scope}:staging`, owner.request)
  const changed = new SessionSearchCatalogClient<true>(`${owner.scope}:changed`, owner.request)
  let cursor: SessionIndexJsonlCursor | undefined
  let signature: string | undefined
  let pending = 0
  const mark = async (key: string) => {
    if (!(await changed.get(key))) {
      await changed.put(key, true)
      pending++
    }
  }
  const changes = async function* () {
    while (pending) {
      const page = await changed.page()
      for (const { key } of page.rows) {
        try {
          yield key
        } finally {
          await changed.delete(key)
          pending--
        }
      }
    }
  }
  const observe: SessionDiscoveryDependencyObserver = async (force) => {
    let stat
    try {
      stat = await wslGatedStat(path, 'scan')
    } catch (error) {
      if (!isMissingTranscriptPathError(error)) {
        throw error
      }
      let after: string | undefined
      do {
        const page = await accepted.page({ after })
        for (const { key } of page.rows) {
          await mark(key)
        }
        after = page.after
      } while (after !== undefined)
      await accepted.release()
      cursor = undefined
      signature = undefined
      return changes()
    }
    const nextSignature = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
    if (!force && signature === nextSignature) {
      return changes()
    }
    const append = await canAppendSessionIndexJsonl(path, stat, cursor)
    await staging.release()
    let batch = new Map<string, string>()
    const apply = (line: string) => {
      const entry = parse(line)
      if (entry) {
        batch.set(entry[0], entry[1])
      }
    }
    const drain = async () => {
      for (const [key, value] of batch) {
        await staging.put(key, value)
      }
      batch = new Map()
    }
    const start = append ? cursor!.offset : 0
    const result = await consumeCompleteJsonlLines({ path, start, onLine: apply, drain })
    if (result.trailingPartialLine) {
      apply(result.trailingPartialLine)
    }
    await drain()
    const firstRecord = append
      ? cursor!.firstRecord
      : result.consumedThrough > 0
        ? await firstRecordSignature(path, result.consumedThrough)
        : null
    let after: string | undefined
    do {
      const page = await staging.page({ after })
      for (const { key, value } of page.rows) {
        if ((await accepted.get(key)) !== value) {
          await mark(key)
        }
        await accepted.put(key, value)
      }
      after = page.after
    } while (after !== undefined)
    if (!append) {
      after = undefined
      do {
        const page = await accepted.page({ after })
        for (const { key } of page.rows) {
          if ((await staging.get(key)) === undefined) {
            await mark(key)
            await accepted.delete(key)
          }
        }
        after = page.after
      } while (after !== undefined)
    }
    cursor = {
      offset: result.consumedThrough,
      readThrough: start + result.bytesRead,
      dev: stat.dev,
      ino: stat.ino,
      firstRecord
    }
    signature = nextSignature
    await staging.release()
    return changes()
  }
  Object.defineProperty(observe, 'pending', { get: () => pending > 0 })
  return observe
}
