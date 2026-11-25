import { lstat, mkdir, realpath, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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

/** Drops the prompt history link: a symlink, or on Windows a hardlink to the same file. */
async function separatePromptHistory(
  profile: string,
  home: string
): Promise<ClaudeProfileSurfaceOutcome> {
  const source = join(profile, HISTORY)
  const destination = join(home, HISTORY)
  const entry = await lstat(source).catch(() => null)
  const shared = await stat(destination, { bigint: true }).catch(() => null)
  if (!entry || !shared) {
    return 'unchanged'
  }
  const linked = entry.isSymbolicLink()
    ? (await realpath(source).catch(() => null)) === (await realpath(destination))
    : await stat(source, { bigint: true }).then(
        (own) => own.dev === shared.dev && own.ino === shared.ino
      )
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
