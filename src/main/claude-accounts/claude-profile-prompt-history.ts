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
  claim,
  CONFLICT,
  drainClaim,
  drainPending,
  HISTORY,
  recoverPending,
  retireProved,
  setAside,
  settleClaim,
  type Claim,
  type Proof
} from './claude-profile-prompt-history-pending'
import {
  ClaudeProfileSurfaceError,
  warnClaudeProfile,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from './claude-profile-report'

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

// New copies are staged in private claims, so no delayed step of another setup can reach a later
// copy staged under a repeated name. An older build does not merge a claim a crash left behind;
// the next newer build does.
function stageHistory(parent: HistoryDirectory): Claim | undefined {
  return claim(parent, HISTORY)
}

// A collision keeps both; the conflict copy stays where it is.
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

function retained(detail: string): ClaudeProfileSurfaceError {
  return new ClaudeProfileSurfaceError('retained-conflict', detail)
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
  // The original staged from H, once this setup moved it aside.
  let aside: Claim | undefined
  try {
    // A publication is exactly our link to the shared file: a symlink to it, or on Windows another name of it.
    const isPublication: Proof = (directory, name) =>
      platform === 'win32'
        ? directory.kind(name) === 'file' &&
          directory.identity(name) === homeDirectory.identity(HISTORY)
        : directory.kind(name) === 'link' && directory.readLink(name) === destination
    const pending = recoverPending(parent, isPublication, report)
    // Check volumes before draining to keep prompts private when linking is refused.
    if (platform === 'win32' && pending.legacy.length + pending.claims.length > 0) {
      if (statSync(profile).dev !== statSync(destination).dev) {
        throw crossFilesystem()
      }
    }
    drainPending(parent, pending, profile, destination, shared, isPublication, report)

    const record = join(profile, LINK_RECORD)
    // What H holds now: a publication is done, a different link or entry is the user's.
    const settled = (): ClaudeProfileSurfaceOutcome | undefined => {
      const current = parent.kind(HISTORY)
      if (current === 'link') {
        return realpathSync(source) === realpathSync(destination) ? 'unchanged' : 'user-owned'
      }
      if (current !== null && current !== 'file') {
        return 'user-owned'
      }
      if (!current || !isPublication(parent, HISTORY)) {
        return undefined
      }
      if (platform === 'win32') {
        const sharedIdentity = fileIdentity(statSync(destination, { bigint: true }))
        if (readLinkRecord(profile) !== sharedIdentity) {
          writeFileAtomically(record, `${sharedIdentity}\n`, { mode: 0o600 })
        }
      }
      return 'unchanged'
    }
    const done = settled()
    if (done) {
      return done
    }
    const current = parent.kind(HISTORY)
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
    let conflict: string | undefined
    if (current) {
      // A rival may have published its link after the check: that link is redundant, and a
      // different link or entry put there is the user's.
      if (replaced) {
        conflict = setAside(parent, HISTORY, CONFLICT)
        if (conflict && isPublication(parent, conflict)) {
          retireProved(parent, conflict, (claimed) => isPublication(claimed, HISTORY))
          conflict = undefined
        }
      } else {
        aside = stageHistory(parent)
        const original = (staged: HistoryDirectory) =>
          staged.kind(HISTORY) === 'file' && !isPublication(staged, HISTORY)
        if (aside && !original(aside.directory)) {
          const outcome = settleClaim(parent, aside, HISTORY, (claimed) =>
            isPublication(claimed, HISTORY)
          )
          if (outcome === 'kept') {
            const detail = `Prompt history changed during setup; it is kept at ${join(profile, aside.name)}`
            warnClaudeProfile(report, HISTORY, retained(detail))
          }
          aside.directory.close()
          aside = undefined
        }
      }
      if (!aside && !conflict && parent.kind(HISTORY) !== null) {
        const now = settled()
        if (now) {
          return now
        }
        throw retained(`Prompt history changed during setup; a later setup merges ${source}`)
      }
    }
    const finish = (outcome: ClaudeProfileSurfaceOutcome): ClaudeProfileSurfaceOutcome => {
      if (conflict) {
        const detail = `Shared prompt history was replaced; the old copy is kept at ${join(profile, conflict)}`
        warnClaudeProfile(report, HISTORY, retained(detail))
      } else if (aside) {
        drainClaim(parent, aside, destination, shared)
      }
      return outcome
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
              throw retained(
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
      try {
        if (aside && settleClaim(parent, aside, HISTORY, () => false) !== 'kept') {
          aside.directory.close()
          aside = undefined
        }
        if (conflict && restoreHistory(parent, conflict) !== 'collision') {
          conflict = undefined
        }
        // Another setup may have shared H meanwhile; then only the copy set aside is left to merge.
        if (settled() === 'unchanged') {
          return finish('unchanged')
        }
        const kept = aside ? aside.name : conflict
        if (kept) {
          throw retained(`Prompt history kept at ${join(profile, kept)}`)
        }
      } catch (restoreError) {
        warnClaudeProfile(report, HISTORY, restoreError)
      }
      throw new ClaudeProfileSurfaceError('link-failed', String(error))
    }
    return finish('linked')
  } finally {
    aside?.directory.close()
    homeDirectory.close()
    parent.close()
  }
}
