import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { realFolderUnderRoot } from '../../filesystem/real-folder-under-root'

const header = (agentName: string) =>
  `<!-- Orca writes this file for ${agentName} chats in this folder; edits are replaced. -->`

const BLOCK_START = '<!-- orca:begin -->'
const BLOCK_END = '<!-- orca:end -->'

/** Orca's own file is replaced whole; a file the user wrote keeps their text and gets Orca's block. */
function withOrcaText(existing: string | null, rawText: string, agentName: string): string {
  const text = rawText.replace(/<!--\s*orca:(begin|end)\s*-->/g, '')
  if (existing === null || existing.startsWith(header(agentName))) {
    return `${header(agentName)}\n\n${text}\n`
  }
  const block = `${BLOCK_START}\n${text}\n${BLOCK_END}`
  const range = orcaBlockRange(existing)
  if (range) {
    return existing.slice(0, range.start) + block + existing.slice(range.end)
  }
  return `${existing.trimEnd()}\n\n${block}\n`
}

function orcaBlockRange(existing: string): { start: number; end: number } | null {
  // Only markers alone on their lines count, so text that quotes them is left alone; the last
  // pair wins, so a stray one the user wrote earlier cannot swallow their text.
  const marks = [...existing.matchAll(/^<!-- orca:(begin|end) -->\r?$/gm)]
  // Take the last begin that is followed by an end with no other begin between them.
  const start = marks.findLast((mark, i) => mark[1] === 'begin' && marks[i + 1]?.[1] === 'end')
  const end = start && marks[marks.indexOf(start) + 1]
  return start && end ? { start: start.index, end: end.index + end[0].length } : null
}

/** Writes Orca's text into `cwd`'s `path` whole, so the agent never reads a half-written file.
 *  A symlink on the way, or a file that cannot be read, stays untouched. The result is readable
 *  only by this host's user, a file the user wrote included, since it now carries the bot's
 *  instructions. An inheritable ACL the user set on the folder still applies on top of that.
 *  Returns the file's size in bytes; null when a link or an unreadable file left it as it was. */
export async function writeFolderContextFile(
  cwd: string,
  path: string,
  agentName: string,
  text: string
): Promise<number | null> {
  const realCwd = await realpath(cwd).catch(() => cwd)
  const folders = dirname(path)
    .split(/[\\/]/)
    .filter((segment) => segment && segment !== '.')
  // A linked folder on the way would carry the bot's instructions somewhere else.
  if ((await realFolderUnderRoot(cwd, realCwd, folders)) === 'other') {
    return null
  }
  const target = join(realCwd, path)
  let existing: string | null = null
  const info = await lstat(target).catch(() => null)
  if (info) {
    // A link may point outside the folder or into a tracked file, so it is left as the user's.
    if (info.isSymbolicLink()) {
      return null
    }
    try {
      existing = await readFile(target, 'utf8')
    } catch {
      return null
    }
  } else {
    await mkdir(dirname(target), { recursive: true })
  }
  return replaceWhole(target, withOrcaText(existing, text, agentName)).catch(() => null)
}

/** Takes Orca's text back out of `cwd`'s `path`: deletes a file Orca wrote for `agentName`, or
 *  removes only Orca's block from a file the user wrote. A symlink or unreadable file stays. */
export async function removeFolderContextFile(
  cwd: string,
  path: string,
  agentName: string
): Promise<void> {
  const target = join(await realpath(cwd).catch(() => cwd), path)
  const info = await lstat(target).catch(() => null)
  const existing = info?.isFile() ? await readFile(target, 'utf8').catch(() => null) : null
  if (existing === null) {
    return
  }
  if (existing.startsWith(header(agentName))) {
    await rm(target, { force: true })
    return
  }
  const range = orcaBlockRange(existing)
  if (range) {
    const before = existing.slice(0, range.start).trimEnd()
    const after = existing.slice(range.end).trimStart()
    await replaceWhole(target, `${[before, after].filter(Boolean).join('\n\n')}\n`)
  }
}

async function replaceWhole(target: string, content: string): Promise<number> {
  const staged = `${target}.${randomUUID()}`
  try {
    await writeFile(staged, content, { mode: 0o600 })
    await rename(staged, target)
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined)
    throw error
  }
  return Buffer.byteLength(content)
}
