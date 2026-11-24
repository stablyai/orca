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
  // Only markers alone on their lines count, so text that quotes them is left alone; the last
  // pair wins, so a stray one the user wrote earlier cannot swallow their text.
  const marks = [...existing.matchAll(/^<!-- orca:(begin|end) -->\r?$/gm)]
  // Take the last begin that is followed by an end with no other begin between them.
  const start = marks.findLast((mark, i) => mark[1] === 'begin' && marks[i + 1]?.[1] === 'end')
  const end = start && marks[marks.indexOf(start) + 1]
  if (start && end) {
    const endAt = end.index + end[0].length
    return existing.slice(0, start.index) + block + existing.slice(endAt)
  }
  return `${existing.trimEnd()}\n\n${block}\n`
}

/** Writes Orca's text into `cwd`'s `path` whole, so the agent never reads a half-written file.
 *  A symlink on the way, or a file that cannot be read, stays untouched. The result is readable
 *  only by this host's user, a file the user wrote included, since it now carries the bot's
 *  instructions. An inheritable ACL the user set on the folder still applies on top of that. */
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
  const staged = `${target}.${randomUUID()}`
  try {
    await writeFile(staged, withOrcaText(existing, text, agentName), { mode: 0o600 })
    await rename(staged, target)
    return true
  } catch (error) {
    await rm(staged, { force: true }).catch(() => undefined)
    throw error
  }
}
