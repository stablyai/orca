import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { encodeClaudeProjectPaths } from '../../../ai-vault/claude-project-dir-encoding'
import {
  listStoreDirectory,
  statStoreFile,
  type StorePresence,
  type StoreReadBudget
} from './store-walk'
import { reportedHome, type SavedResumeStoreQuery } from './store-query'

// Claude truncates longer project folder names and appends a hash Orca does not reproduce.
const MAX_PROJECT_DIR_NAME = 200
const MAX_PROJECT_DIRS = 5_000

/** The common pattern's check: `<id>.jsonl` in any project folder of the launch's own store.
 *  A miss proves absence only when every project folder was checked and the launch folder's own
 *  project exists to have held it. The folder is the one the invocation reported it runs with. */
export async function claudeStorePresence(
  query: SavedResumeStoreQuery,
  budget: StoreReadBudget
): Promise<StorePresence> {
  const cwd = query.providerSession.cwd ?? query.cwd
  const home = reportedHome(query.roots)
  const root = query.roots.CLAUDE_CONFIG_DIR?.trim() || (home && join(home, '.claude'))
  if (!root || !isAbsolute(root) || !cwd) {
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
