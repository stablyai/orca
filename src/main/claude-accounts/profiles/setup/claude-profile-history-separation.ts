import { lstat, mkdir, readlink, realpath, rm, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isLinkedDirectory, removeDirectoryLink } from '../../../filesystem/merged-directory-link'
import { resolveClaudeDefaultHome } from '../claude-profile-paths'
import {
  createClaudeProfileReport,
  runClaudeProfileSurface,
  type ClaudeProfileReport,
  type ClaudeProfileSurfaceOutcome
} from '../claude-profile-report'
import { CLAUDE_PROFILE_HISTORY_DIRS } from './claude-profile-history'

const HISTORY = 'history.jsonl'
const LINK_RECORD = `${HISTORY}.orca-profile-link`

/** A history folder still linked to System default's becomes the account's own, empty one. The
 *  shared history is never touched: what was written before stays where it was. */
async function separateDirectory(
  profile: string,
  home: string,
  name: string
): Promise<ClaudeProfileSurfaceOutcome> {
  const source = join(profile, name)
  if (!(await isLinkedDirectory(source, join(home, name)))) {
    return 'unchanged'
  }
  await removeDirectoryLink(source)
  await mkdir(source, { recursive: true, mode: 0o700 })
  return 'synced'
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Drops the prompt history link: a symlink, or on Windows a hardlink to the same file. */
async function separatePromptHistory(
  profile: string,
  home: string
): Promise<ClaudeProfileSurfaceOutcome> {
  const source = join(profile, HISTORY)
  const destination = join(home, HISTORY)
  const entry = await lstat(source).catch(() => null)
  if (!entry) {
    return 'unchanged'
  }
  let linked: boolean
  if (entry.isSymbolicLink()) {
    // A link left dangling by a deleted shared file would share again once it is recreated.
    linked =
      samePath(resolve(profile, await readlink(source)), destination) ||
      (await realpath(source).catch(() => null)) ===
        (await realpath(destination).catch(() => undefined))
  } else {
    const shared = await stat(destination, { bigint: true }).catch(() => null)
    linked =
      shared !== null &&
      (await stat(source, { bigint: true }).then(
        (own) => own.dev === shared.dev && own.ino === shared.ino
      ))
  }
  if (!linked) {
    return 'unchanged'
  }
  await unlink(source)
  await rm(join(profile, LINK_RECORD), { force: true })
  return 'synced'
}

/** Call after profile ownership checks on the execution host, in place of sharing its history. */
export async function separateClaudeProfileHistory(args: {
  profileHome: string
  userHome: string
  /** The user's own CLAUDE_CONFIG_DIR; `~/.claude` when unset. */
  userConfigDir?: string
}): Promise<ClaudeProfileReport> {
  const report = createClaudeProfileReport()
  const home = resolveClaudeDefaultHome(args.userHome, args.userConfigDir)
  for (const name of CLAUDE_PROFILE_HISTORY_DIRS) {
    await runClaudeProfileSurface(report, name, () =>
      separateDirectory(args.profileHome, home, name)
    )
  }
  await runClaudeProfileSurface(report, HISTORY, () =>
    separatePromptHistory(args.profileHome, home)
  )
  return report
}
