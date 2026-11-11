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
  const staging = new SessionSearchCatalogClient<string>(`${owner.scope}:staging`, owner.request)
  const changed = new SessionSearchCatalogClient<true>(`${owner.scope}:changed`, owner.request)
  const accepted = new SessionSearchCatalogClient<string>(`${owner.scope}:accepted`, owner.request)
  let cursor: SessionIndexJsonlCursor | undefined
  let signature: string | undefined
  const transition = async (phase: 'install' | 'remove') => {
    if (!(phase === 'install' ? staging.size : accepted.size)) {
      return
    }
    let after: string | undefined
    do {
      after = (
        await changed.transition({ kind: 'dependency-step', scope: owner.scope, phase, after })
      ).after
    } while (after !== undefined)
  }
  const changes = async function* () {
    while (changed.size) {
      const page = await changed.page()
      await changed.transition({
        kind: 'dependency-deliver',
        scope: owner.scope,
        keys: page.rows.map(({ key }) => key)
      })
      for (const { key } of page.rows) {
        yield key
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
      if (staging.size) {
        await staging.release()
      }
      await transition('remove')
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
      await staging.putPage([...batch].map(([key, value]) => staging.encode(key, value)))
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
    await transition('install')
    if (!append) {
      await transition('remove')
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
  Object.defineProperty(observe, 'pending', { get: () => changed.size > 0 })
  return observe
}
