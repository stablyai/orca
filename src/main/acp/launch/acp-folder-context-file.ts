import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { realFolderUnderRoot } from '../../filesystem/real-folder-under-root'

const header = (agentName: string) =>
  `<!-- Orca writes this file for ${agentName} chats in this folder; edits are replaced. -->`

const BLOCK_START = '<!-- orca:begin -->'
const BLOCK_END = '<!-- orca:end -->'
// Only markers alone on their lines count, so text that quotes them is left alone.
const ORCA_MARK = /^<!-- orca:(begin|end) -->\r?$/gm

/** Where the block Orca replaces sits, so writing one and taking it out name the same span. */
function orcaBlockSpan(existing: string): { at: number; until: number } | null {
  const marks = [...existing.matchAll(ORCA_MARK)]
  // The last begin followed by an end with no other begin between them, so a stray one the user
  // wrote earlier cannot swallow their text.
  const start = marks.findLast((mark, i) => mark[1] === 'begin' && marks[i + 1]?.[1] === 'end')
  if (!start) {
    return null
  }
  const end = marks[marks.indexOf(start) + 1]
  return { at: start.index, until: end.index + end[0].length }
}

/** Orca's own file is replaced whole; a file the user wrote keeps their text and gets Orca's block. */
function withOrcaText(existing: string | null, rawText: string, agentName: string): string {
  const text = rawText.replace(/<!--\s*orca:(begin|end)\s*-->/g, '')
  if (existing === null || existing.startsWith(header(agentName))) {
    return `${header(agentName)}\n\n${text}\n`
  }
  const block = `${BLOCK_START}\n${text}\n${BLOCK_END}`
  const span = orcaBlockSpan(existing)
  if (span) {
    return existing.slice(0, span.at) + block + existing.slice(span.until)
  }
  return `${existing.trimEnd()}\n\n${block}\n`
}

/** The real file `path` names in `cwd`; null when a linked folder on the way leads elsewhere. */
async function realFolderContextTarget(cwd: string, path: string): Promise<string | null> {
  const realCwd = await realpath(cwd).catch(() => cwd)
  const folders = dirname(path)
    .split(/[\\/]/)
    .filter((segment) => segment && segment !== '.')
  // A linked folder on the way would carry the bot's instructions somewhere else.
  if ((await realFolderUnderRoot(cwd, realCwd, folders)) === 'other') {
    return null
  }
  return join(realCwd, path)
}

/** What the folder already holds there; a file the user owns stays theirs. */
async function readExistingFolderContextFile(
  target: string
): Promise<{ kind: 'missing' } | { kind: 'untouched' } | { kind: 'file'; text: string }> {
  const info = await lstat(target).catch(() => null)
  if (!info) {
    return { kind: 'missing' }
  }
  // A link may point outside the folder or into a tracked file, so it is left as the user's.
  if (info.isSymbolicLink()) {
    return { kind: 'untouched' }
  }
  try {
    return { kind: 'file', text: await readFile(target, 'utf8') }
  } catch {
    return { kind: 'untouched' }
  }
}

/** Writes `content` atomically with user-only permissions so the agent never reads a half-written file. */
async function writeFolderContextText(target: string, content: string): Promise<void> {
  const staged = `${target}.${randomUUID()}`
  try {
    await writeFile(staged, content, { mode: 0o600 })
    await rename(staged, target)
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Writes Orca's text into `cwd`'s `path` whole, so the agent never reads a half-written file.
 *  A symlink on the way, or a file that cannot be read, stays untouched and returns `false`.
 *  The result is readable only by this host's user, a file the user wrote included, since it now
 *  carries the bot's instructions. An inheritable ACL the user set on the folder still applies. */
export async function writeFolderContextFile(
  cwd: string,
  path: string,
  agentName: string,
  text: string
): Promise<boolean> {
  const target = await realFolderContextTarget(cwd, path)
  if (!target) {
    return false
  }
  const existing = await readExistingFolderContextFile(target)
  if (existing.kind === 'untouched') {
    return false
  }
  if (existing.kind === 'missing') {
    await mkdir(dirname(target), { recursive: true })
  }
  await writeFolderContextText(
    target,
    withOrcaText(existing.kind === 'file' ? existing.text : null, text, agentName)
  )
  return true
}

/** Takes Orca's text back out of `cwd`'s `path`: deletes a file Orca wrote for `agentName`, or
 *  removes only Orca's block from a file the user wrote. A symlink or unreadable file stays. */
export async function removeFolderContextFile(
  cwd: string,
  path: string,
  agentName: string
): Promise<void> {
  const target = await realFolderContextTarget(cwd, path)
  if (!target) {
    return
  }
  const existing = await readExistingFolderContextFile(target)
  if (existing.kind !== 'file') {
    return
  }
  if (existing.text.startsWith(header(agentName))) {
    await rm(target, { force: true })
    return
  }
  const span = orcaBlockSpan(existing.text)
  if (!span) {
    return
  }
  // Only the end of `before` and separating line endings of `after` are tidied: the user's own
  // first line may open an indented code block, and its indentation is theirs to keep.
  const before = existing.text.slice(0, span.at).trimEnd()
  const after = existing.text
    .slice(span.until)
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .trimEnd()
  if (!before && !after) {
    await rm(target, { force: true })
    return
  }
  await writeFolderContextText(target, `${[before, after].filter(Boolean).join('\n\n')}\n`)
}
