import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { encodeClaudeProjectPaths } from '../../../ai-vault/claude-project-dir-encoding'
import {
  listStoreDirectory,
  readStoreHead,
  type StorePresence,
  type StoreReadBudget
} from './store-walk'
import { shellStartupAssigns, type SavedResumeStoreQuery } from './store-query'

// Claude truncates longer project folder names and appends a hash Orca does not reproduce.
const MAX_PROJECT_DIR_NAME = 200
const TRANSCRIPT_HEAD_BYTES = 8 * 1024

/** Transcript filenames can differ from the session id, so every transcript is classified by the
 *  id its records carry; one Claude cannot classify keeps a miss unknown. */
export async function claudeStorePresence(
  query: SavedResumeStoreQuery,
  budget: StoreReadBudget
): Promise<StorePresence> {
  const configured = query.launchEnv.CLAUDE_CONFIG_DIR?.trim()
  const cwd = query.providerSession.cwd ?? query.cwd
  if ((!configured && shellStartupAssigns('CLAUDE_CONFIG_DIR', query.launchEnv)) || !cwd) {
    return 'unknown'
  }
  const resolvedCwd = await realpath(cwd).catch(() => cwd)
  const ownProjects = new Set([cwd, resolvedCwd].flatMap(encodeClaudeProjectPaths))
  if ([...ownProjects].some((name) => name.length > MAX_PROJECT_DIR_NAME)) {
    return 'unknown'
  }
  const projects = join(configured || join(homedir(), '.claude'), 'projects')
  const id = query.providerSession.id
  let ownProjectSeen = false
  let classified = true
  try {
    for await (const project of listStoreDirectory(projects, budget)) {
      if (!project.isDirectory()) {
        classified &&= !project.isSymbolicLink()
        continue
      }
      ownProjectSeen ||= ownProjects.has(project.name)
      for await (const entry of listStoreDirectory(join(projects, project.name), budget)) {
        if (!entry.name.endsWith('.jsonl')) {
          continue
        }
        if (entry.name === `${id}.jsonl`) {
          return 'found'
        }
        const head = await readStoreHead(
          join(projects, project.name, entry.name),
          TRANSCRIPT_HEAD_BYTES,
          budget
        )
        if (head.includes(`"sessionId":"${id}"`)) {
          return 'found'
        }
        classified &&= head.includes('"sessionId":"')
      }
    }
  } catch {
    return 'unknown'
  }
  // A miss proves absence only where the launch folder's own project could have held it.
  return ownProjectSeen && classified ? 'missing' : 'unknown'
}
