import {
  appendFileSync,
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
  type Stats
} from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { renameFileWithWindowsRetry, writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  ClaudeProfileSurfaceError,
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'

export const CLAUDE_PROFILE_MERGE_SUFFIX = '.orca-profile-merge'
const HISTORY = 'history.jsonl'
const PENDING = `${HISTORY}${CLAUDE_PROFILE_MERGE_SUFFIX}`
// Windows only: identity of the shared file Orca last hardlinked, so a replaced one is told apart.
const LINK_RECORD = `${HISTORY}.orca-profile-link`

export function lstatIfPresent(file: string): Stats | undefined {
  try {
    return lstatSync(file)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
    return undefined
  }
}

function appendHistory(destination: string, lines: string[]): void {
  if (lines.length === 0) {
    return
  }
  const size = statSync(destination).size
  let separator = false
  if (size > 0) {
    const fd = openSync(destination, 'r')
    try {
      const tail = Buffer.alloc(1)
      readSync(fd, tail, 0, 1, size - 1)
      separator = tail[0] !== 10
    } finally {
      closeSync(fd)
    }
  }
  // Why: every record ends its line so it cannot fuse with Claude's next append.
  appendFileSync(destination, `${separator ? '\n' : ''}${lines.join('\n')}\n`)
}

/**
 * Keeps the renamed file and its cursor: a Claude that opened the old path just before the swap
 * appends there, and the next run drains it; a later run that finds nothing new deletes it.
 */
function drainHistory(pending: string, destination: string, shared: Set<string>): void {
  const content = readFileSync(pending)
  const cursor = `${pending}.offset`
  let offset = 0
  let saved = false
  try {
    const stored = Number(readFileSync(cursor, 'utf8'))
    if (Number.isSafeInteger(stored) && stored >= 0 && stored <= content.length) {
      offset = stored
      saved = true
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  if (saved && offset === content.length) {
    // Why: cursor first; a copy without one re-drains to nothing because its lines are present.
    unlinkSync(cursor)
    unlinkSync(pending)
    return
  }
  // Why: `claude purge` rewrites the shared file through the link; only lines it lacks are new.
  const lines = content
    .subarray(offset)
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '' && !shared.has(line))
  appendHistory(destination, lines)
  for (const line of lines) {
    shared.add(line)
  }
  // Advance only after append; a crash re-drains, and lines already present are skipped.
  writeFileSync(cursor, `${content.length}\n`, { mode: 0o600 })
}

function pendingGeneration(name: string): number | null {
  if (name === PENDING) {
    return 0
  }
  const suffix = name.slice(PENDING.length + 1)
  return name.startsWith(`${PENDING}-`) && /^\d+$/.test(suffix) ? Number(suffix) : null
}

function nextFreePath(base: string): string {
  for (let generation = 0; ; generation++) {
    const candidate = generation === 0 ? base : `${base}-${generation}`
    if (!lstatIfPresent(candidate)) {
      return candidate
    }
  }
}

function fileIdentity(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}`
}

export function crossFilesystem(): ClaudeProfileSurfaceError {
  return new ClaudeProfileSurfaceError(
    'cross-filesystem',
    'History stays private across filesystems'
  )
}

/** Fails closed: an unreadable record must not read as "no link", which would drain a replaced default back. */
function readLinkRecord(profile: string): string | null {
  try {
    return readFileSync(join(profile, LINK_RECORD), 'utf8').trim()
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw new ClaudeProfileSurfaceError(
      'unreadable',
      `Prompt history link record: ${String(error)}`
    )
  }
}

/**
 * Links the profile's `history.jsonl` to the shared one (a same-volume hardlink on Windows, which
 * needs no privilege) and appends its own lines.
 */
export function mergeClaudeProfilePromptHistory(
  profile: string,
  home: string,
  platform: NodeJS.Platform,
  report: ClaudeProfileReport
): ClaudeProfileSurfaceOutcome {
  const source = join(profile, HISTORY)
  const destination = join(home, HISTORY)
  if (!lstatIfPresent(destination)) {
    writeFileSync(destination, '', { flag: 'wx', mode: 0o600 })
  }
  const shared = new Set(readFileSync(destination, 'utf8').split('\n'))
  const pendings: { name: string; generation: number }[] = []
  for (const item of readdirSync(profile, { withFileTypes: true })) {
    const generation = pendingGeneration(item.name)
    if (item.isFile() && generation !== null) {
      pendings.push({ name: item.name, generation })
    }
  }
  // Why: directory order is not creation order; generations keep prompts in the order they were written.
  pendings.sort((left, right) => left.generation - right.generation)
  // Why: a cross-volume share is refused below; draining first would leak this account's prompts.
  if (platform === 'win32' && pendings.length > 0) {
    if (statSync(profile).dev !== statSync(destination).dev) {
      throw crossFilesystem()
    }
  }
  for (const { name } of pendings) {
    try {
      drainHistory(join(profile, name), destination, shared)
    } catch (error) {
      // Why: an old retained copy is bookkeeping; it must not keep the profile from being linked.
      warnClaudeProfile(report, HISTORY, error)
    }
  }
  const current = lstatIfPresent(source)
  if (current?.isSymbolicLink()) {
    return realpathSync(source) === realpathSync(destination) ? 'unchanged' : 'user-owned'
  }
  if (current && !current.isFile()) {
    return 'user-owned'
  }
  const record = join(profile, LINK_RECORD)
  let sharedIdentity: string | undefined
  let replaced = false
  if (platform === 'win32') {
    sharedIdentity = fileIdentity(statSync(destination, { bigint: true }))
    const identity = current ? fileIdentity(lstatSync(source, { bigint: true })) : undefined
    if (identity === sharedIdentity) {
      if (readLinkRecord(profile) !== sharedIdentity) {
        writeFileAtomically(record, `${sharedIdentity}\n`, { mode: 0o600 })
      }
      return 'unchanged'
    }
    if (statSync(profile).dev !== statSync(destination).dev) {
      throw crossFilesystem()
    }
    // Why: the old shared file still held under Orca's link means the default was replaced or
    // cleared; draining it would bring back history the user removed.
    replaced = identity !== undefined && identity === readLinkRecord(profile)
  }
  let aside: string | undefined
  if (current) {
    aside = nextFreePath(join(profile, replaced ? `${HISTORY}.orca-profile-conflict` : PENDING))
    renameFileWithWindowsRetry(source, aside)
  }
  try {
    if (sharedIdentity === undefined) {
      symlinkSync(destination, source)
    } else {
      linkSync(destination, source)
      try {
        writeFileAtomically(record, `${sharedIdentity}\n`, { mode: 0o600 })
      } catch (error) {
        // Why: a link without its record would let a later default replacement drain the old copy back.
        unlinkSync(source)
        throw error
      }
    }
  } catch (error) {
    if (aside && !lstatIfPresent(source)) {
      renameFileWithWindowsRetry(aside, source)
    }
    throw new ClaudeProfileSurfaceError('link-failed', String(error))
  }
  if (aside && replaced) {
    const detail = `Shared prompt history was replaced; the old copy is kept at ${aside}`
    warnClaudeProfile(report, HISTORY, new ClaudeProfileSurfaceError('retained-conflict', detail))
  } else if (aside) {
    drainHistory(aside, destination, shared)
  }
  return 'linked'
}
