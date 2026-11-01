import { basename, dirname, join } from 'node:path'
import { forEachSessionFile } from '../ai-vault/session-scanner-discovery'
import { admitTranscriptPath } from './transcript-path-admission'

export function codexPhysicalRolloutId(path: string): string | null {
  const match = basename(path).match(
    /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\.jsonl(?:\.zst)?$/i
  )
  return (match?.[2] ?? match?.[1])?.toLowerCase() ?? null
}

export async function codexHistorySources(filePath: string, roots?: readonly string[]) {
  let stores: string[] | undefined
  let selected = filePath
  for (const root of roots ?? []) {
    const name = basename(root)
    const candidates =
      name === 'sessions' || name === 'archived_sessions'
        ? [join(dirname(root), 'sessions'), join(dirname(root), 'archived_sessions')]
        : [root]
    for (const store of candidates) {
      const admitted = await admitTranscriptPath(store, filePath)
      if (admitted) {
        stores = candidates
        selected = admitted.path
        break
      }
    }
    if (stores) {
      break
    }
  }
  if (roots?.length && !stores) {
    throw new Error('The conversation is outside its account storage.')
  }
  const paths = new Map<string, string>()
  let indexedStores = 0
  return { path: selected, resolve }

  async function resolve(id: string): Promise<string> {
    if (!stores) {
      throw new Error('The conversation history account is unavailable.')
    }
    const key = id.toLowerCase()
    while (!paths.has(key) && indexedStores < stores.length) {
      const indexed = new Map<string, string>()
      await forEachSessionFile(
        stores[indexedStores],
        'codex',
        [],
        { extensions: new Set(['.jsonl', '.zst']), strictErrors: true },
        (path) => {
          const physicalId = codexPhysicalRolloutId(path)
          if (!physicalId) {
            return
          }
          const previous = indexed.get(physicalId)
          // Prefer a plain file over its compressed sibling within this store.
          if (!previous || `${path}.zst` === previous) {
            indexed.set(physicalId, path)
          }
        }
      )
      for (const [physicalId, path] of indexed) {
        if (!paths.has(physicalId)) {
          paths.set(physicalId, path)
        }
      }
      indexedStores += 1
    }
    const found = paths.get(key)
    if (found) {
      for (const store of stores) {
        const admitted = await admitTranscriptPath(store, found)
        if (admitted) {
          return admitted.path
        }
      }
    }
    throw new Error('The conversation history source is unavailable.')
  }
}
