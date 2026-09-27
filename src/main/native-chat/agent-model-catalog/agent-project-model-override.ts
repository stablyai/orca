import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

// A listing's default is the account's, but a chat runs in a workspace whose own
// config can pick another model. These checks only look for such config; they
// never read what it picks, so a hit means "name no default", not a model.

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** A `.git` file (linked worktree) or a `.git` directory with a HEAD marks a project root. */
async function isProjectRoot(dir: string): Promise<boolean> {
  const git = join(dir, '.git')
  try {
    const entry = await stat(git)
    return entry.isFile() || (await exists(join(git, 'HEAD')))
  } catch {
    return false
  }
}

/**
 * The directories a chat started in `cwd` reads project config from: each one
 * from the project root (the nearest ancestor holding `.git`, else `cwd`
 * itself) down to `cwd`.
 */
async function projectConfigDirectories(cwd: string): Promise<string[]> {
  const chain: string[] = []
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    chain.push(dir)
    if (await isProjectRoot(dir)) {
      return chain
    }
    if (dirname(dir) === dir) {
      return [resolve(cwd)]
    }
  }
}

/** Codex skips the `.codex` that is its own home; any other one with a config is a layer. */
function directoryMayOverride(dir: string, accountHomePath: string): Promise<boolean> {
  const layer = join(dir, '.codex')
  return layer === resolve(accountHomePath)
    ? Promise.resolve(false)
    : exists(join(layer, 'config.toml'))
}

/** True when a new chat in `workspacePath` could run a model other than the listed default. */
export async function workspaceMayOverrideDefaultModel(input: {
  agent: 'claude' | 'codex'
  workspacePath: string
  accountHomePath: string
}): Promise<boolean> {
  // Claude's user settings or env can pick another model wherever it runs; only Codex's listed default is its configured one.
  if (input.agent !== 'codex') {
    return true
  }
  const dirs = await projectConfigDirectories(input.workspacePath)
  const results = await Promise.all(
    dirs.map((dir) => directoryMayOverride(dir, input.accountHomePath))
  )
  return results.some(Boolean)
}
