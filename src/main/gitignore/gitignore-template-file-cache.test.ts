import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { GitignoreTemplateFileCache } from './gitignore-template-file-cache'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('GitignoreTemplateFileCache', () => {
  it('serializes updates from separate cache instances targeting the same file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-gitignore-cache-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'cache.json')
    const first = new GitignoreTemplateFileCache(filePath)
    const second = new GitignoreTemplateFileCache(filePath)

    await Promise.all([
      first.update((cache) => ({
        ...cache,
        templates: { ...cache.templates, Node: { fetchedAt: 1, content: 'node_modules/\n' } }
      })),
      second.update((cache) => ({
        ...cache,
        templates: { ...cache.templates, Rust: { fetchedAt: 2, content: 'target/\n' } }
      }))
    ])

    expect((await first.read())?.templates).toEqual({
      Node: { fetchedAt: 1, content: 'node_modules/\n' },
      Rust: { fetchedAt: 2, content: 'target/\n' }
    })
  })
})
