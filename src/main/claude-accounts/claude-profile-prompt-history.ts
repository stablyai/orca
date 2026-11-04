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
// Track Windows hardlink identity to detect replacement of the shared file.
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
  // Terminate records so Claude's next append starts on its own line.
  appendFileSync(destination, `${separator ? '\n' : ''}${lines.join('\n')}\n`)
}

// Retain the renamed file until a later drain finds no appends from handles opened before the swap.
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
    // Delete the cursor first so an interrupted cleanup safely replays deduplicated lines.
    unlinkSync(cursor)
    unlinkSync(pending)
    return
  }
  // CLI rewrites can replay shared lines; append only missing ones.
  const lines = content
    .subarray(offset)
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '' && !shared.has(line))
  appendHistory(destination, lines)
  for (const line of lines) {
    shared.add(line)
  }
  // Advance after append so interrupted drains replay safely through deduplication.
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

// Treating an unreadable record as absent could restore history the user deleted.
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

/** Use a same-volume hardlink on Windows to avoid requiring symlink privileges. */
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
  // Directory enumeration order does not preserve prompt chronology.
  pendings.sort((left, right) => left.generation - right.generation)
  // Check volumes before draining to keep prompts private when linking is refused.
  if (platform === 'win32' && pendings.length > 0) {
    if (statSync(profile).dev !== statSync(destination).dev) {
      throw crossFilesystem()
    }
  }
  for (const { name } of pendings) {
    try {
      drainHistory(join(profile, name), destination, shared)
    } catch (error) {
      // A failed drain must not prevent linking the profile.
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
    // A replaced shared file must not regain deleted history from the old hardlink.
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
        // Without the record, a later replacement could restore deleted history.
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
