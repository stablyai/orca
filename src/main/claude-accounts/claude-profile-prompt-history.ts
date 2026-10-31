import {
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats,
  type Stats
} from 'node:fs'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { loadHistoryFilesystem, type HistoryDirectory } from '../../shared/history-filesystem'
import { runFileOperationWithWindowsRetry } from '../../shared/windows-retry-file-operations'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  absentAs,
  CLAIM,
  claimPending,
  drainHistory,
  HISTORY,
  legacyPending,
  retireProved
} from './claude-profile-prompt-history-pending'
import {
  ClaudeProfileSurfaceError,
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'

export const CLAUDE_PROFILE_MERGE_SUFFIX = '.orca-profile-merge'
const PENDING = `${HISTORY}${CLAUDE_PROFILE_MERGE_SUFFIX}`
const CONFLICT = `${HISTORY}.orca-profile-conflict`
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

function pendingGeneration(name: string): number | null {
  if (name === PENDING) {
    return 0
  }
  const suffix = name.slice(PENDING.length + 1)
  return name.startsWith(`${PENDING}-`) && /^\d+$/.test(suffix) ? Number(suffix) : null
}

// An occupied generation is a collision, never a replacement; try the next one exclusively.
// Staged copies keep the names older builds recover after an interrupted setup.
function stageHistory(parent: HistoryDirectory, base: string, first: number): string | undefined {
  for (let generation = first; ; generation++) {
    const name = generation === 0 ? base : `${base}-${generation}`
    const moved = runFileOperationWithWindowsRetry(() => parent.move(HISTORY, parent, name))
    if (moved !== 'collision') {
      return moved === 'moved' ? name : undefined
    }
  }
}

// A collision keeps both; a staged pending copy is merged by the next setup.
function restoreHistory(
  parent: HistoryDirectory,
  aside: string
): 'moved' | 'collision' | 'missing' {
  return runFileOperationWithWindowsRetry(() => parent.move(aside, parent, HISTORY))
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

type Proof = (directory: HistoryDirectory, name: string) => boolean

// One bounded pass: drain surviving copies, and retire what is proved redundant (a moved-aside
// publication, a cursor whose copy is gone). Unknown entries and retained originals stay.
function recoverPending(
  parent: HistoryDirectory,
  profile: string,
  isPublication: Proof,
  report: ClaudeProfileReport
): { legacy: string[]; claims: string[] } {
  const names = new Set(parent.entries())
  const legacy: { name: string; generation: number }[] = []
  const claims: string[] = []
  for (const name of names) {
    const generation = pendingGeneration(name)
    const copy = name.endsWith('.offset') ? name.slice(0, -'.offset'.length) : undefined
    try {
      if (generation !== null) {
        if (isPublication(parent, name)) {
          retireProved(parent, name, (claimed) => isPublication(claimed, HISTORY))
        } else if (parent.kind(name) === 'file') {
          legacy.push({ name, generation })
        }
      } else if (name.startsWith(CLAIM) && parent.kind(name) === 'directory') {
        claims.push(name)
      } else if (copy && pendingGeneration(copy) !== null && !names.has(copy)) {
        // Left by a drain that finished after another retired its copy; a new copy under that
        // name must not inherit it.
        if (parent.kind(name) === 'file') {
          absentAs(() => parent.unlink(name), undefined)
        }
      }
    } catch (error) {
      warnClaudeProfile(report, HISTORY, error)
    }
  }
  // Directory enumeration order does not preserve prompt chronology.
  legacy.sort((left, right) => left.generation - right.generation)
  return { legacy: legacy.map(({ name }) => join(profile, name)), claims }
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
  const filesystem = loadHistoryFilesystem()
  const parent = filesystem.openDirectory(profile, false)
  const homeDirectory = filesystem.openDirectory(home, true)
  try {
    // A publication is exactly our link to the shared file: a symlink to it, or on Windows another name of it.
    const isPublication: Proof = (directory, name) =>
      platform === 'win32'
        ? directory.kind(name) === 'file' &&
          directory.identity(name) === homeDirectory.identity(HISTORY)
        : directory.kind(name) === 'link' && directory.readLink(name) === destination
    const { legacy, claims } = recoverPending(parent, profile, isPublication, report)
    // Check volumes before draining to keep prompts private when linking is refused.
    if (platform === 'win32' && legacy.length + claims.length > 0) {
      if (statSync(profile).dev !== statSync(destination).dev) {
        throw crossFilesystem()
      }
    }
    for (const path of legacy) {
      try {
        drainHistory(legacyPending(path), destination, shared)
      } catch (error) {
        // A failed drain must not prevent linking the profile.
        warnClaudeProfile(report, HISTORY, error)
      }
    }
    for (const name of claims) {
      try {
        const claimed = { name, directory: parent.open(name) }
        try {
          const pending = claimPending(parent, claimed)
          if (isPublication(claimed.directory, HISTORY)) {
            pending.retire()
          } else {
            drainHistory(pending, destination, shared)
          }
        } finally {
          claimed.directory.close()
        }
      } catch (error) {
        warnClaudeProfile(report, HISTORY, error)
      }
    }

    // What H holds now: a publication is done, a different link or entry is the user's.
    const settled = (): ClaudeProfileSurfaceOutcome | undefined => {
      const current = parent.kind(HISTORY)
      if (current === 'link') {
        return realpathSync(source) === realpathSync(destination) ? 'unchanged' : 'user-owned'
      }
      if (current !== null && current !== 'file') {
        return 'user-owned'
      }
      return current && isPublication(parent, HISTORY) ? 'unchanged' : undefined
    }
    const done = settled()
    if (done) {
      if (done === 'unchanged' && platform === 'win32' && parent.kind(HISTORY) === 'file') {
        const sharedIdentity = fileIdentity(statSync(destination, { bigint: true }))
        if (readLinkRecord(profile) !== sharedIdentity) {
          writeFileAtomically(join(profile, LINK_RECORD), `${sharedIdentity}\n`, { mode: 0o600 })
        }
      }
      return done
    }
    const current = parent.kind(HISTORY)
    const record = join(profile, LINK_RECORD)
    let sharedIdentity: string | undefined
    let replaced = false
    if (platform === 'win32') {
      sharedIdentity = fileIdentity(statSync(destination, { bigint: true }))
      if (statSync(profile).dev !== statSync(destination).dev) {
        throw crossFilesystem()
      }
      // A replaced shared file must not regain deleted history from the old hardlink.
      replaced =
        current !== null &&
        fileIdentity(lstatSync(source, { bigint: true })) === readLinkRecord(profile)
    }
    let aside: string | undefined
    if (current) {
      aside = replaced
        ? stageHistory(parent, CONFLICT, 0)
        : stageHistory(parent, PENDING, Date.now())
      // A rival may have published its link after the check; that link is not an original.
      if (aside && (parent.kind(aside) !== 'file' || isPublication(parent, aside))) {
        const restored = restoreHistory(parent, aside)
        if (restored === 'collision' && isPublication(parent, aside)) {
          retireProved(parent, aside, (claimed) => isPublication(claimed, HISTORY))
        }
        if (restored === 'moved' || parent.kind(HISTORY) !== null) {
          const now = settled()
          if (now) {
            return now
          }
          throw new ClaudeProfileSurfaceError(
            'retained-conflict',
            `Prompt history changed during setup; a later setup merges ${source}`
          )
        }
        // The moved-aside link was consumed and nothing took its place: publish.
        aside = undefined
      }
    }
    try {
      if (sharedIdentity === undefined) {
        symlinkSync(destination, source)
      } else {
        const published = homeDirectory.identity(HISTORY)
        linkSync(destination, source)
        try {
          writeFileAtomically(record, `${sharedIdentity}\n`, { mode: 0o600 })
        } catch (error) {
          // Without the record, a later replacement could restore deleted history. Claude may
          // already have replaced the link, so only a claimed, proved link is removed.
          try {
            const undone = retireProved(
              parent,
              HISTORY,
              (claimed) =>
                claimed.kind(HISTORY) === 'file' && claimed.identity(HISTORY) === published
            )
            if (undone === 'kept') {
              throw new ClaudeProfileSurfaceError(
                'retained-conflict',
                `Prompt history replaced during setup is kept for a later merge in ${profile}`
              )
            }
          } catch (undoError) {
            warnClaudeProfile(report, HISTORY, undoError)
          }
          throw error
        }
      }
    } catch (error) {
      if (aside) {
        try {
          if (restoreHistory(parent, aside) === 'collision') {
            throw new ClaudeProfileSurfaceError(
              'retained-conflict',
              `Prompt history kept at ${join(profile, aside)}`
            )
          }
        } catch (restoreError) {
          warnClaudeProfile(report, HISTORY, restoreError)
        }
      }
      throw new ClaudeProfileSurfaceError('link-failed', String(error))
    }
    if (aside && replaced) {
      const detail = `Shared prompt history was replaced; the old copy is kept at ${join(profile, aside)}`
      warnClaudeProfile(report, HISTORY, new ClaudeProfileSurfaceError('retained-conflict', detail))
    } else if (aside) {
      drainHistory(legacyPending(join(profile, aside)), destination, shared)
    }
    return 'linked'
  } finally {
    homeDirectory.close()
    parent.close()
  }
}
