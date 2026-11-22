import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { realFolderUnderRoot } from '../../filesystem/real-folder-under-root'

const header = (agentName: string) =>
  `<!-- Orca writes this file for ${agentName} chats in this folder; edits are replaced. -->`

const BLOCK_START = '<!-- orca:begin -->'
const BLOCK_END = '<!-- orca:end -->'

/** The last begin/end marker pair with no begin between them. Only markers alone on their lines
 *  count, so text that quotes them is left alone; the last pair wins, so a stray one the user
 *  wrote earlier cannot swallow their text. */
function lastOrcaBlock(existing: string): { start: RegExpExecArray; end: RegExpExecArray } | null {
  const marks = [...existing.matchAll(/^<!-- orca:(begin|end) -->\r?$/gm)]
  const start = marks.findLast((mark, i) => mark[1] === 'begin' && marks[i + 1]?.[1] === 'end')
  const end = start && marks[marks.indexOf(start) + 1]
  return start && end ? { start, end } : null
}

/** Orca's own file is replaced whole; a file the user wrote keeps their text and gets Orca's block. */
function withOrcaText(existing: string | null, rawText: string, agentName: string): string {
  const text = rawText.replace(/<!--\s*orca:(begin|end)\s*-->/g, '')
  if (existing === null || existing.startsWith(header(agentName))) {
    return `${header(agentName)}\n\n${text}\n`
  }
  const block = `${BLOCK_START}\n${text}\n${BLOCK_END}`
  const pair = lastOrcaBlock(existing)
  if (pair) {
    const endAt = pair.end.index + pair.end[0].length
    return existing.slice(0, pair.start.index) + block + existing.slice(endAt)
  }
  return `${existing.trimEnd()}\n\n${block}\n`
}

/** `existing` without the block Orca last wrote into it, or itself when it carries none. */
function withoutOrcaText(existing: string): string {
  const pair = lastOrcaBlock(existing)
  if (!pair) {
    return existing
  }
  const before = existing.slice(0, pair.start.index)
  const after = existing.slice(pair.end.index + pair.end[0].length)
  // A block Orca appended sat behind the "\n\n" it added, so dropping it leaves the user's text.
  if (after.trim() === '') {
    return before.trimEnd() ? `${before.trimEnd()}\n` : ''
  }
  // One in the middle leaves one line break where its lines were the gap.
  const dropsSeparator = before === '' || /(?:\r?\n){2}$/.test(before)
  return before + (dropsSeparator ? after.replace(/^\r?\n/, '') : after)
}

/** `content` replaces `target` whole, readable only by this host's user, so the agent never reads
 *  a half-written file. */
async function replaceFile(target: string, content: string): Promise<void> {
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
 *  A symlink on the way, or a file that cannot be read, stays untouched and reports false. The
 *  result is readable only by this host's user, a file the user wrote included, since it now
 *  carries the bot's instructions. An inheritable ACL the user set on the folder still applies
 *  on top of that. */
export async function writeFolderContextFile(
  cwd: string,
  path: string,
  agentName: string,
  text: string
): Promise<boolean> {
  const realCwd = await realpath(cwd).catch(() => cwd)
  const folders = dirname(path)
    .split(/[\\/]/)
    .filter((segment) => segment && segment !== '.')
  // A linked folder on the way would carry the bot's instructions somewhere else.
  if ((await realFolderUnderRoot(cwd, realCwd, folders)) === 'other') {
    return false
  }
  const target = join(realCwd, path)
  let existing: string | null = null
  const info = await lstat(target).catch(() => null)
  if (info) {
    // A link may point outside the folder or into a tracked file, so it is left as the user's.
    if (info.isSymbolicLink()) {
      return false
    }
    try {
      existing = await readFile(target, 'utf8')
    } catch {
      return false
    }
  } else {
    await mkdir(dirname(target), { recursive: true })
  }
  await replaceFile(target, withOrcaText(existing, text, agentName))
  return true
}

/** Removes what a launch wrote into `cwd`'s `path`: a file Orca wrote whole is deleted, one the
 *  user wrote keeps their text without Orca's block. A linked folder on the way, a symlink, or a
 *  file that cannot be read stays untouched, as the writer leaves them. */
export async function clearFolderContextFile(
  cwd: string,
  path: string,
  agentName: string
): Promise<void> {
  const realCwd = await realpath(cwd).catch(() => cwd)
  const folders = dirname(path)
    .split(/[\\/]/)
    .filter((segment) => segment && segment !== '.')
  if ((await realFolderUnderRoot(cwd, realCwd, folders)) === 'other') {
    return
  }
  const target = join(realCwd, path)
  const info = await lstat(target).catch(() => null)
  if (!info || info.isSymbolicLink()) {
    return
  }
  let existing: string
  try {
    existing = await readFile(target, 'utf8')
  } catch {
    return
  }
  if (existing.startsWith(header(agentName))) {
    await rm(target, { force: true })
    return
  }
  const cleared = withoutOrcaText(existing)
  if (cleared !== existing) {
    await replaceFile(target, cleared)
  }
}
