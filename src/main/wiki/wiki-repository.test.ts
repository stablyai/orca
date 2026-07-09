import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readWikiNote,
  readWikiOverview,
  resolveWikiRootRelativePath,
  resolveWikiTarget
} from './wiki-repository'

let root: string

async function seedWiki(files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, '.wiki', rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, body, 'utf8')
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wiki-repo-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('readWikiOverview', () => {
  it('reports no wiki when .wiki is missing', async () => {
    const result = await readWikiOverview(root, 'my-repo')
    expect(result).toEqual({ hasWiki: false, rootRelativePath: null, notes: [] })
  })

  it('lists notes and resolves Home.md as root', async () => {
    await seedWiki({ 'Home.md': '# Home', 'Бизнес-логика/Feature.md': '# F' })
    const result = await readWikiOverview(root, 'my-repo')
    expect(result.hasWiki).toBe(true)
    expect(result.rootRelativePath).toBe('Home.md')
    expect(result.notes).toEqual(['Home.md', 'Бизнес-логика/Feature.md'])
  })
})

describe('resolveWikiRootRelativePath', () => {
  it('prefers Home over repo-named over index over README over first', () => {
    expect(resolveWikiRootRelativePath(['README.md', 'my-repo.md', 'Home.md'], 'my-repo')).toBe(
      'Home.md'
    )
    expect(resolveWikiRootRelativePath(['README.md', 'my-repo.md'], 'my-repo')).toBe('my-repo.md')
    expect(resolveWikiRootRelativePath(['b.md', 'a.md'], 'my-repo')).toBe('a.md')
    expect(resolveWikiRootRelativePath([], 'my-repo')).toBeNull()
  })
})

describe('readWikiNote', () => {
  it('reads a note by relative path', async () => {
    await seedWiki({ 'Home.md': '# Home' })
    const note = await readWikiNote(root, 'Home.md')
    expect(note).toEqual({ relativePath: 'Home.md', content: '# Home' })
  })

  it('rejects traversal outside .wiki', async () => {
    await seedWiki({ 'Home.md': '# Home' })
    expect(await readWikiNote(root, '../secret.md')).toBeNull()
    expect(await readWikiNote(root, '../../etc/passwd')).toBeNull()
  })

  it('rejects non-markdown', async () => {
    expect(await readWikiNote(root, 'Home.txt')).toBeNull()
  })

  it('rejects a symlink inside .wiki that points outside it', async () => {
    const outside = join(root, 'secret.md')
    await writeFile(outside, '# Secret', 'utf8')
    await mkdir(join(root, '.wiki'), { recursive: true })
    try {
      await symlink(outside, join(root, '.wiki', 'leak.md'))
    } catch {
      // Why: symlink creation can be unsupported (e.g. Windows without privilege) — skip gracefully.
      return
    }
    expect(await readWikiNote(root, 'leak.md')).toBeNull()
  })

  it('rejects Windows-style drive/backslash paths', async () => {
    await seedWiki({ 'Home.md': '# Home' })
    expect(await readWikiNote(root, 'D:\\secret.md')).toBeNull()
    expect(await readWikiNote(root, 'sub\\..\\..\\secret.md')).toBeNull()
  })
})

describe('resolveWikiTarget', () => {
  const notes = ['Home.md', 'Бизнес-логика/Feature.md', 'Сервисы/svc.md']
  it('resolves a wikilink by basename', () => {
    expect(resolveWikiTarget(notes, 'Home.md', '[[Feature]]')).toBe('Бизнес-логика/Feature.md')
    expect(resolveWikiTarget(notes, 'Home.md', 'Feature')).toBe('Бизнес-логика/Feature.md')
  })
  it('resolves a relative markdown link against the source note dir', () => {
    expect(resolveWikiTarget(notes, 'Бизнес-логика/Feature.md', '../Сервисы/svc.md')).toBe(
      'Сервисы/svc.md'
    )
  })
  it('returns null for external or unknown targets', () => {
    expect(resolveWikiTarget(notes, 'Home.md', 'https://example.com')).toBeNull()
    expect(resolveWikiTarget(notes, 'Home.md', 'Nope')).toBeNull()
  })
  it('resolves percent-encoded links to notes with literal spaces', () => {
    const spaced = ['Home.md', 'docsai — Architecture.md', 'Business logic/Contract check.md']
    expect(resolveWikiTarget(spaced, 'Home.md', './docsai%20—%20Architecture.md')).toBe(
      'docsai — Architecture.md'
    )
    expect(resolveWikiTarget(spaced, 'Home.md', './Business%20logic/Contract%20check.md')).toBe(
      'Business logic/Contract check.md'
    )
  })
})
