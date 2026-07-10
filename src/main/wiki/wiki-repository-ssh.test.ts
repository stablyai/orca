import { describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'
import { readWikiNoteSsh, readWikiOverviewSsh } from './wiki-repository-ssh'

const WORKTREE = '/remote/repo'
const WIKI_DIR = '/remote/repo/.wiki'

function fakeProvider(overrides: Partial<IFilesystemProvider>): IFilesystemProvider {
  const notImplemented = () => {
    throw new Error('not implemented')
  }
  return {
    readDir: notImplemented,
    readFile: notImplemented,
    writeFile: notImplemented,
    writeFileBase64: notImplemented,
    writeFileBase64Chunk: notImplemented,
    stat: notImplemented,
    deletePath: notImplemented,
    createFile: notImplemented,
    createDir: notImplemented,
    createDirNoClobber: notImplemented,
    rename: notImplemented,
    renameNoClobber: notImplemented,
    copy: notImplemented,
    realpath: notImplemented,
    search: notImplemented,
    listFiles: notImplemented,
    watch: notImplemented,
    ...overrides
  } as IFilesystemProvider
}

describe('readWikiOverviewSsh', () => {
  it('reports no wiki when listFiles returns empty', async () => {
    const provider = fakeProvider({ listFiles: async () => [] })
    expect(await readWikiOverviewSsh(provider, WORKTREE, 'my-repo')).toEqual({
      hasWiki: false,
      rootRelativePath: null,
      notes: []
    })
  })

  it('reports no wiki when listFiles throws', async () => {
    const provider = fakeProvider({
      listFiles: async () => {
        throw new Error('no such dir')
      }
    })
    expect(await readWikiOverviewSsh(provider, WORKTREE, 'my-repo')).toEqual({
      hasWiki: false,
      rootRelativePath: null,
      notes: []
    })
  })

  it('lists notes filtered to markdown and sorted, with Home.md as root', async () => {
    const provider = fakeProvider({
      listFiles: async () => ['notes/Feature.md', 'Home.md', 'image.png']
    })
    const result = await readWikiOverviewSsh(provider, WORKTREE, 'my-repo')
    expect(result.hasWiki).toBe(true)
    expect(result.rootRelativePath).toBe('Home.md')
    expect(result.notes).toEqual(['Home.md', 'notes/Feature.md'])
  })
})

describe('readWikiNoteSsh', () => {
  it('reads a note', async () => {
    const statSpy = vi.fn(async () => ({ size: 10, type: 'file' as const, mtime: 0 }))
    const readFileSpy = vi.fn(async () => ({ content: '# Home', isBinary: false }))
    const provider = fakeProvider({
      realpath: async (p: string) => p,
      stat: statSpy,
      readFile: readFileSpy
    })
    const result = await readWikiNoteSsh(provider, WORKTREE, 'Home.md')
    expect(result).toEqual({ relativePath: 'Home.md', content: '# Home' })
    // Why: regression guard for the leading-slash strip bug — provider must see absolute paths.
    expect(statSpy).toHaveBeenCalledWith('/remote/repo/.wiki/Home.md')
    expect(readFileSpy).toHaveBeenCalledWith('/remote/repo/.wiki/Home.md')
  })

  it('rejects when stat.type is not file', async () => {
    const provider = fakeProvider({
      realpath: async (p: string) => p,
      stat: async () => ({ size: 0, type: 'directory', mtime: 0 })
    })
    expect(await readWikiNoteSsh(provider, WORKTREE, 'Home.md')).toBeNull()
  })

  it('rejects binary content', async () => {
    const provider = fakeProvider({
      realpath: async (p: string) => p,
      stat: async () => ({ size: 10, type: 'file', mtime: 0 }),
      readFile: async () => ({ content: '', isBinary: true })
    })
    expect(await readWikiNoteSsh(provider, WORKTREE, 'Home.md')).toBeNull()
  })

  it('rejects traversal outside .wiki', async () => {
    const provider = fakeProvider({})
    expect(await readWikiNoteSsh(provider, WORKTREE, '../secret.md')).toBeNull()
  })

  it('rejects a symlink escape outside the wiki dir', async () => {
    const provider = fakeProvider({
      realpath: async (p: string) => (p === `${WIKI_DIR}/leak.md` ? '/repo/secret.md' : WIKI_DIR)
    })
    expect(await readWikiNoteSsh(provider, WORKTREE, 'leak.md')).toBeNull()
  })
})
