import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type * as FileSystem from 'node:fs'
import { RangedFileDocuments } from './ranged-file-documents'

const notifications: { changed?: (event: string, name: string | null) => void } = vi.hoisted(
  () => ({})
)
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof FileSystem>()
  const { EventEmitter } = await import('node:events')
  return {
    ...original,
    watch: (_path: unknown, changed: (event: string, name: string | null) => void) => {
      notifications.changed = changed
      const watcher = new EventEmitter()
      return Object.assign(watcher, { close: () => {}, unref: () => watcher })
    }
  }
})

it('invalidates a delivered own-file change even when native revision metadata is unchanged', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-range-watch-'))
  const path = join(folder, 'document.bin')
  const documents = new RangedFileDocuments()
  try {
    await writeFile(path, 'before')
    const document = await documents.open('owner', async () => path)
    // The external notification can arrive while coarse revision fields still equal the opened revision.
    notifications.changed!('change', basename(path))
    expect((await documents.status('owner', document.id)).valid).toBe(false)
    await expect(
      documents.read('owner', {
        id: document.id,
        version: document.version,
        offset: 0,
        length: 6,
        requestToken: 'read'
      })
    ).rejects.toThrow('stale')
    await writeFile(path, 'after!')
    const next = await documents.reload('owner', document.id)
    const read = await documents.read('owner', {
      id: next.id,
      version: next.version,
      offset: 0,
      length: 6,
      requestToken: 'read'
    })
    expect(read.contentBase64).toBe('YWZ0ZXIh')
  } finally {
    await documents.closeOwner('owner')
    await rm(folder, { recursive: true, force: true })
  }
})
