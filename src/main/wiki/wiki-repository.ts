import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, posix, relative, resolve } from 'node:path'
import { isMarkdownDocumentName } from '../ipc/markdown-documents'
import { isDescendantOrEqual } from '../ipc/filesystem-auth'

const WIKI_DIR = '.wiki'
const ROOT_CANDIDATES = ['Home.md', 'index.md', 'README.md']

/** Returns the absolute path to a worktree's `.wiki/` directory. */
export function resolveWikiDir(worktreePath: string): string {
  return join(worktreePath, WIKI_DIR)
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/')
}

/** True if a relative path stays inside `.wiki/`: no `..` traversal, no backslashes, no Windows drive letters. */
export function isContainedRelativePath(relativePath: string): boolean {
  // Why: reject traversal, and Windows drive-letter/backslash paths (Orca supports Windows).
  if (!relativePath || relativePath.includes('\\') || /^[a-zA-Z]:/.test(relativePath)) {
    return false
  }
  return !relativePath.split('/').includes('..')
}

async function listWikiNotes(wikiDir: string): Promise<string[]> {
  const notes: string[] = []
  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue
      }
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') {
          continue
        }
        await visit(abs)
        continue
      }
      if (entry.isFile() && isMarkdownDocumentName(entry.name)) {
        notes.push(toPosix(relative(wikiDir, abs)))
      }
    }
  }
  await visit(wikiDir)
  return notes.sort((a, b) => a.localeCompare(b))
}

/** Picks the wiki's root/home note from `notes`: Home.md, `<repoName>.md`, index.md, README.md, else the alphabetically first note. */
export function resolveWikiRootRelativePath(notes: string[], repoName: string): string | null {
  const ordered = [ROOT_CANDIDATES[0], `${repoName}.md`, ROOT_CANDIDATES[1], ROOT_CANDIDATES[2]]
  for (const candidate of ordered) {
    const match = notes.find((note) => note.toLowerCase() === candidate.toLowerCase())
    if (match) {
      return match
    }
  }
  if (notes.length === 0) {
    return null
  }
  // Why: "first .md" means alphabetically first, not first in input order.
  return [...notes].sort((a, b) => a.localeCompare(b))[0]
}

/** Builds the wiki overview result (hasWiki/rootRelativePath/notes) from a list of note paths. */
export function shapeWikiOverview(
  notes: string[],
  repoName: string
): { hasWiki: boolean; rootRelativePath: string | null; notes: string[] } {
  if (notes.length === 0) {
    return { hasWiki: false, rootRelativePath: null, notes: [] }
  }
  return { hasWiki: true, rootRelativePath: resolveWikiRootRelativePath(notes, repoName), notes }
}

/** Lists a local worktree's `.wiki/` notes recursively and resolves its root note. */
export async function readWikiOverview(
  worktreePath: string,
  repoName: string
): Promise<{ hasWiki: boolean; rootRelativePath: string | null; notes: string[] }> {
  const wikiDir = resolveWikiDir(worktreePath)
  const notes = await listWikiNotes(wikiDir)
  return shapeWikiOverview(notes, repoName)
}

/** Reads one local `.wiki/` note, rejecting paths that escape `.wiki/` (including via symlinks) or aren't markdown. */
export async function readWikiNote(
  worktreePath: string,
  relativePath: string
): Promise<{ relativePath: string; content: string } | null> {
  // Why: check the raw input for backslashes/drive letters before toPosix would silently convert them away.
  if (!isContainedRelativePath(relativePath)) {
    return null
  }
  const normalized = toPosix(relativePath).replace(/^\/+/, '')
  if (!isMarkdownDocumentName(normalized)) {
    return null
  }
  const wikiDir = resolveWikiDir(worktreePath)
  const abs = join(wikiDir, normalized)
  // Why: defence in depth — confirm the resolved absolute path stays inside .wiki/.
  const rel = relative(resolve(wikiDir), resolve(abs))
  if (rel.startsWith('..')) {
    return null
  }
  try {
    // Why: resolve() is string-only, so a symlink in .wiki/ could still point outside it — check the real path too.
    const [realWikiDir, realAbs] = await Promise.all([realpath(wikiDir), realpath(abs)])
    if (!isDescendantOrEqual(realAbs, realWikiDir)) {
      return null
    }
    const fileStat = await stat(abs)
    if (!fileStat.isFile()) {
      return null
    }
    const content = await readFile(abs, 'utf8')
    return { relativePath: normalized, content }
  } catch {
    return null
  }
}

// Why: agents write links with percent-encoded paths (spaces -> %20), but note
// paths on disk keep literal spaces — decode before matching so links resolve.
function safeDecodeHref(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Resolves a clicked link's href (wikilink, relative path, or bare basename) to a note path in `notes`, or null if it doesn't match one. */
export function resolveWikiTarget(
  notes: string[],
  fromRelativePath: string,
  rawHref: string
): string | null {
  const href = rawHref.trim()
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return null
  } // external scheme
  const wikilink = href.match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/)
  if (wikilink) {
    const wanted = wikilink[1].trim().toLowerCase()
    return (
      notes.find((note) => {
        const base = note.slice(note.lastIndexOf('/') + 1)
        const name = base.replace(/\.(md|mdx|markdown)$/i, '')
        return name.toLowerCase() === wanted || base.toLowerCase() === `${wanted}.md`
      }) ?? null
    )
  }
  const cleanHref = safeDecodeHref(href.replace(/^\.?\//, '').split(/[?#]/)[0])
  if (!cleanHref) {
    return null
  }
  const fromDir = fromRelativePath.includes('/')
    ? fromRelativePath.slice(0, fromRelativePath.lastIndexOf('/'))
    : ''
  const joined = posix.normalize(fromDir ? `${fromDir}/${cleanHref}` : cleanHref)
  if (joined.startsWith('..')) {
    return null
  }
  const target = notes.find((note) => note === joined)
  if (target) {
    return target
  }
  // wikilink-style bare basename fallback
  return (
    notes.find(
      (note) =>
        note.slice(note.lastIndexOf('/') + 1).toLowerCase() === `${cleanHref.toLowerCase()}.md`
    ) ?? null
  )
}
