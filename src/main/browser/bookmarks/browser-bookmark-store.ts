import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  browserBookmarkSchema,
  browserBookmarkScopeKey,
  parseBrowserBookmarkScopeKey,
  type BrowserBookmark,
  type BrowserBookmarkMutation,
  type BrowserBookmarkMutationResult,
  type BrowserBookmarks,
  type BrowserBookmarkScope
} from '../../../shared/browser/bookmarks/browser-bookmarks'
import { durableWriteTempPath, writeFileDurable } from '../../filesystem/durable-file-write'
import { withSidecarSnapshotQueue } from '../../filesystem/sidecar-snapshot-file'

async function readBookmarks(path: string): Promise<BrowserBookmarks> {
  let contents: string
  try {
    contents = await readFile(path, 'utf-8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw error
  }
  const stored: unknown = JSON.parse(contents)
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('Invalid browser bookmarks file')
  }
  const bookmarks: BrowserBookmarks = {}
  for (const [key, rows] of Object.entries(stored)) {
    if (!Array.isArray(rows) || !parseBrowserBookmarkScopeKey(key)) {
      continue
    }
    const ids = new Set<string>()
    const urls = new Set<string>()
    const entries: BrowserBookmark[] = []
    for (const row of rows) {
      const parsed = browserBookmarkSchema.safeParse(row)
      if (!parsed.success) {
        continue
      }
      const entry = parsed.data
      if (!ids.has(entry.id) && !urls.has(entry.url)) {
        ids.add(entry.id)
        urls.add(entry.url)
        entries.push(entry)
      }
    }
    bookmarks[key] = entries
  }
  return bookmarks
}

export class BrowserBookmarkStore {
  private readonly path: string
  private bookmarks: BrowserBookmarks | null = null

  constructor(profileDirectory: string) {
    this.path = join(profileDirectory, 'browser-bookmarks.json')
  }

  list(): Promise<BrowserBookmarks> {
    return withSidecarSnapshotQueue(this.path, () => this.load())
  }

  mutate(
    scope: BrowserBookmarkScope,
    mutation: BrowserBookmarkMutation
  ): Promise<BrowserBookmarkMutationResult> {
    return withSidecarSnapshotQueue(this.path, async () => {
      const bookmarks = await this.load()
      const key = browserBookmarkScopeKey(scope)
      const entries = bookmarks[key] ?? []
      const index = mutation.kind === 'add' ? -1 : entries.findIndex(({ id }) => id === mutation.id)
      if (mutation.kind !== 'add' && index < 0) {
        return 'missing'
      }
      if (
        mutation.kind !== 'remove' &&
        entries.some(({ url }, i) => url === mutation.url && i !== index)
      ) {
        return 'duplicate'
      }
      const next = [...entries]
      if (mutation.kind === 'remove') {
        next.splice(index, 1)
      } else {
        const { title, url } = mutation
        const bookmark = {
          id: mutation.kind === 'add' ? randomUUID() : mutation.id,
          title: title || url,
          url
        }
        if (mutation.kind === 'add') {
          next.unshift(bookmark)
        } else {
          next[index] = bookmark
        }
      }
      await this.save({ ...bookmarks, [key]: next })
      return 'saved'
    })
  }

  forgetLocalProfile(profileId: string): Promise<void> {
    return withSidecarSnapshotQueue(this.path, async () => {
      const bookmarks = await this.load()
      const ownedKeys = Object.keys(bookmarks).filter((key) => {
        const scope = parseBrowserBookmarkScopeKey(key)
        return scope?.[1] === profileId && !scope[0]?.startsWith('runtime:')
      })
      if (ownedKeys.length > 0) {
        const remaining = { ...bookmarks }
        for (const key of ownedKeys) {
          delete remaining[key]
        }
        await this.save(remaining)
      }
    })
  }

  private async load(): Promise<BrowserBookmarks> {
    return (this.bookmarks ??= await readBookmarks(this.path))
  }

  private async save(bookmarks: BrowserBookmarks): Promise<void> {
    await writeFileDurable(
      durableWriteTempPath(this.path),
      this.path,
      `${JSON.stringify(bookmarks, null, 2)}\n`,
      0o600
    )
    this.bookmarks = bookmarks
  }
}
