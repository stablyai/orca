import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isHardLinkUnsupported } from '../../filesystem/hard-link-unsupported-error'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { errnoCodeOrUnknown } from '../../../shared/errors/errno-code'
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
  // An exactly empty file gets the block alone, so removal can give it back byte-for-byte.
  return `${existing === '' ? '' : `${existing.trimEnd()}\n\n`}${block}\n`
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
 *  A symlink on the way, or a file that cannot be read as UTF-8, stays untouched. The result is readable
 *  only by this host's user, a file the user wrote included, since it now carries the bot's
 *  instructions. An inheritable ACL the user set on the folder still applies on top of that. */
export async function writeFolderContextFile(
  cwd: string,
  path: string,
  agentName: string,
  text: string
): Promise<void> {
  const realCwd = await realpath(cwd).catch(() => resolve(cwd))
  const folders = dirname(path)
    .split(/[\\/]/)
    .filter((segment) => segment && segment !== '.')
  // A linked folder on the way would carry the bot's instructions somewhere else.
  if ((await realFolderUnderRoot(cwd, realCwd, folders)) === 'other') {
    return
  }
  const target = join(realCwd, path)
  await replaceWhileUnchanged(
    target,
    async () => {
      const info = await lstat(target).catch(() => null)
      if (!info) {
        await mkdir(dirname(target), { recursive: true })
        return null
      }
      // A link may point outside the folder or into a tracked file, so it is left as the user's.
      return info.isSymbolicLink() ? undefined : readUtf8(target).catch(() => undefined)
    },
    (existing) => withOrcaText(existing, text, agentName)
  )
}

const folderContextSlots = new Map<string, Promise<void>>()

/** Serializes writes to one folder-context file: the slot is held until the returned release
 *  runs, which a session-open hook runs only after the open read the file, so two chats starting
 *  in the same folder cannot read each other's text. */
export async function acquireFolderContextSlot(cwd: string, path: string): Promise<() => void> {
  const target = join(await realpath(cwd).catch(() => resolve(cwd)), path)
  return slotForTarget(target)
}

async function slotForTarget(target: string): Promise<() => void> {
  const previous = folderContextSlots.get(target) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  folderContextSlots.set(target, tail)
  await previous
  return () => {
    release()
    if (folderContextSlots.get(target) === tail) {
      folderContextSlots.delete(target)
    }
  }
}

/** Serializes a folder-context file across the whole chain of folders an agent walking up from
 *  `cwd` would read it in: holds the slot for `path` in `cwd` and in every ancestor, acquired
 *  deepest first so concurrent chains cannot deadlock. Because every chain includes the
 *  filesystem root, two vibe opens never overlap at all; the open is short and abortable, so the
 *  serialization is deliberate. Release runs the releases in reverse. On `signal` abort the slots
 *  taken so far are released and the error is thrown. */
export async function acquireFolderContextSlotChain(
  cwd: string,
  path: string,
  signal?: AbortSignal
): Promise<() => void> {
  // One resolution for the whole chain; ancestors of a resolved path are already canonical.
  const realCwd = await realpath(cwd).catch(() => resolve(cwd))
  const releases: (() => void)[] = []
  const releaseAll = (): void => {
    for (const release of releases.toReversed()) {
      release()
    }
  }
  let dir = realCwd
  for (;;) {
    if (signal?.aborted) {
      releaseAll()
      throw signal.reason ?? new Error('aborted')
    }
    const slot = slotForTarget(join(dir, path))
    if (!signal) {
      releases.push(await slot)
    } else {
      const aborted = abortRejection(signal)
      try {
        releases.push(await Promise.race([slot, aborted]))
      } catch (error) {
        releaseAll()
        throw error
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return releaseAll
}

/** Rejects with the signal's reason, immediately when the signal is already aborted. */
function abortRejection(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('aborted'))
  }
  return new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
      once: true
    })
  })
}

/** Takes Orca's text back out of `cwd`'s `path`: deletes a file Orca wrote for `agentName`, or
 *  removes only Orca's block from a file the user wrote. A symlink, or a file that cannot be
 *  read as UTF-8, stays. Resolves false when Orca's block is still in the file afterwards (every
 *  pass saw a save land), so a leftover is reported instead of passing silently. */
export async function removeFolderContextFile(
  cwd: string,
  path: string,
  agentName: string
): Promise<boolean> {
  const target = join(await realpath(cwd).catch(() => resolve(cwd)), path)
  await replaceWhileUnchanged(
    target,
    async () => {
      const info = await lstat(target).catch(() => null)
      return info?.isFile() ? readUtf8(target).catch(() => undefined) : undefined
    },
    (existing) => (existing === null ? undefined : withoutOrcaText(existing, agentName))
  )
  const info = await lstat(target).catch(() => null)
  // Absent, or not a file Orca could have written, leaves nothing of ours behind. A symlink is
  // read through: the agent follows it, so a block in the link's target is still live.
  if (!info || (!info.isFile() && !info.isSymbolicLink())) {
    return true
  }
  const current = await readUtf8(target).catch(() => undefined)
  if (current === undefined) {
    return true
  }
  return !current.startsWith(header(agentName)) && !orcaBlockRange(current)
}

/** Orca's own file goes whole (null). From a file the user wrote only Orca's block goes, with the
 *  line break after it and the one blank line Orca put before it, so the user's bytes stay; with no
 *  block there is nothing to do (undefined). */
function withoutOrcaText(existing: string, agentName: string): string | null | undefined {
  if (existing.startsWith(header(agentName))) {
    return null
  }
  const range = orcaBlockRange(existing)
  if (!range) {
    return undefined
  }
  let start = range.start
  let end = range.end + (/^\r?\n/.exec(existing.slice(range.end))?.[0].length ?? 0)
  const blankBefore = /(?:^|\n)(\r?\n)$/.exec(existing.slice(0, start))
  const blankAfter = /^\r?\n/.exec(existing.slice(end))
  if (blankBefore && (end === existing.length || blankAfter)) {
    start -= blankBefore[1].length
  }
  return existing.slice(0, start) + existing.slice(end)
}

const UPDATE_PASSES = 3

/** Puts `next(current)` in place of `target` (null deletes it) only while the file still holds the
 *  text it was made from, so a save landing meanwhile is never replaced; the next pass starts from
 *  that save. `read` returns null for no file and undefined for a file to leave alone; `next`
 *  returns undefined when there is nothing to change. The result is
 *  readable only by this host's user, since it carries the bot's instructions. */
async function replaceWhileUnchanged(
  target: string,
  read: () => Promise<string | null | undefined>,
  next: (current: string | null) => string | null | undefined
): Promise<void> {
  for (let pass = 0; pass < UPDATE_PASSES; pass++) {
    const current = await read()
    if (current === undefined) {
      return
    }
    // Rewritten even when equal, so a file made readable by others again goes back to 0600.
    const content = next(current)
    if (content === undefined) {
      return
    }
    if (await publishIfUnchanged(target, current, content)) {
      return
    }
  }
}

/** False, changing nothing, when `target` no longer holds `expected`. The file never goes missing
 *  meanwhile, so no other writer mistakes it for absent; only a save landing between the last
 *  compare and the rename or removal is still replaced, as Node has no compare-and-swap. */
async function publishIfUnchanged(
  target: string,
  expected: string | null,
  content: string | null
): Promise<boolean> {
  const unchanged = async (): Promise<boolean> => (await readIfPresent(target)) === expected
  if (content === null) {
    if (!(await unchanged())) {
      return false
    }
    await rm(target, { force: true })
    return true
  }
  const staged = `${target}.${randomUUID()}`
  try {
    await writeFile(staged, content, { mode: 0o600 })
    if (expected === null) {
      return await createFrom(staged, target)
    }
    if (!(await unchanged())) {
      return false
    }
    await rename(staged, target)
    return true
  } finally {
    await rm(staged, { force: true }).catch(() => undefined)
  }
}

/** Links `staged` in as `target` only when no file took that name first. */
async function createFrom(staged: string, target: string): Promise<boolean> {
  try {
    await link(staged, target)
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'EEXIST') {
      return false
    }
    if (!isHardLinkUnsupported(error)) {
      throw error
    }
  }
  try {
    await copyFile(staged, target, constants.COPYFILE_EXCL)
    return true
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'EEXIST') {
      return false
    }
    throw error
  }
}

async function readIfPresent(path: string): Promise<string | null | undefined> {
  try {
    return await readUtf8(path)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

/** Undefined for bytes that aren't UTF-8: written back as text they would come out changed. */
async function readUtf8(path: string): Promise<string | undefined> {
  const bytes = await readFile(path)
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}
