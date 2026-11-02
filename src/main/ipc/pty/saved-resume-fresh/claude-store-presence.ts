import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, win32 } from 'node:path'
import { encodeClaudeProjectPaths } from '../../../ai-vault/claude-project-dir-encoding'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../../../shared/claude-profile-routing'
import {
  listStoreDirectory,
  statStoreFile,
  type StorePresence,
  type StoreReadBudget
} from './store-walk'
import { shellStartupAssigns, type SavedResumeStoreQuery } from './store-query'

// Claude truncates longer project folder names and appends a hash Orca does not reproduce.
const MAX_PROJECT_DIR_NAME = 200
const MAX_PROJECT_DIRS = 5_000

const trimSlash = (value: string) => value.replace(/[\\/]+$/, '')
const defaultHome = () => join(homedir(), '.claude')

/** The config folder the launch's `claude` runs with: an account pane's shell function reads its
 *  pointer file at launch, so this follows the same chain; anything it cannot settle is null. */
async function resolveClaudeHome(env: NodeJS.ProcessEnv): Promise<string | null> {
  const configured = env.CLAUDE_CONFIG_DIR?.trim()
  const user = env[CLAUDE_USER_CONFIG_DIR_ENV]?.trim()
  const pointer = env[CLAUDE_PROFILE_POINTER_ENV]?.trim()
  if (!pointer) {
    return configured || (shellStartupAssigns('CLAUDE_CONFIG_DIR', env) ? null : defaultHome())
  }
  if (
    configured &&
    configured !== env[CLAUDE_INJECTED_CONFIG_DIR_ENV] &&
    (!user || trimSlash(configured) !== trimSlash(user))
  ) {
    return configured
  }
  if (pointer.startsWith('~/') || !isAbsolute(pointer)) {
    return null
  }
  let profile: string
  try {
    profile = (await readFile(pointer, 'utf8')).replace(/\n+$/, '')
  } catch (error) {
    // A missing pointer is System default, as the shell function treats it.
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      return null
    }
    profile = ''
  }
  if (!profile) {
    return (configured && user) || defaultHome()
  }
  return isAbsolute(profile) || win32.isAbsolute(profile) ? profile : null
}

/** The common pattern's check: `<id>.jsonl` in any project folder of the launch's own store.
 *  A miss proves absence only when every project folder was checked and the launch folder's own
 *  project exists to have held it. */
export async function claudeStorePresence(
  query: SavedResumeStoreQuery,
  budget: StoreReadBudget
): Promise<StorePresence> {
  const cwd = query.providerSession.cwd ?? query.cwd
  const root = await resolveClaudeHome(query.launchEnv)
  if (!root || !cwd) {
    return 'unknown'
  }
  const resolvedCwd = await realpath(cwd).catch(() => cwd)
  const ownProjects = new Set([cwd, resolvedCwd].flatMap(encodeClaudeProjectPaths))
  if ([...ownProjects].some((name) => name.length > MAX_PROJECT_DIR_NAME)) {
    return 'unknown'
  }
  // A recorded transcript can carry another name; it is the same conversation wherever it moved.
  const names = new Set([`${query.providerSession.id}.jsonl`])
  const reported = query.providerSession.transcriptPath
  if (reported) {
    names.add(basename(reported))
  }
  const projects = join(root, 'projects')
  let ownProjectSeen = false
  let projectDirs = 0
  try {
    for await (const project of listStoreDirectory(projects, budget)) {
      if (!project.isDirectory() && !project.isSymbolicLink()) {
        continue
      }
      if ((projectDirs += 1) > MAX_PROJECT_DIRS || Date.now() > budget.deadline) {
        return 'unknown'
      }
      ownProjectSeen ||= ownProjects.has(project.name)
      for (const name of names) {
        const presence = await statStoreFile(join(projects, project.name, name))
        if (presence !== 'missing') {
          return presence
        }
      }
    }
  } catch {
    return 'unknown'
  }
  return ownProjectSeen ? 'missing' : 'unknown'
}
