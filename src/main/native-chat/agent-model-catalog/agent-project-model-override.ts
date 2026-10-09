import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  claudeSettingsMayPickModel,
  codexConfigMayPickModel,
  ompSettingsMayPickModel,
  openCodeAgentFileMayPickModel,
  openCodeConfigMayPickModel
} from './agent-project-model-config-keys'

// A listing's default is the account's, but a chat runs in a workspace whose own
// config can pick another model. These checks only ask whether such config sets a
// model or effort key; they never use what it picks, so a hit means "name no default".

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

type ProjectModelFile = {
  path: string
  mayPickModel: (text: string) => boolean
}

type ProjectModelLayers = {
  /** Files, relative to each directory of the chain, that the agent reads a model from. */
  files: readonly ProjectModelFile[]
  /** Folders of `.md` agent definitions whose frontmatter may pick the model. */
  agentFolders?: readonly { path: string; recursive: boolean }[]
  /** The agent reads every ancestor of the workspace, not only up to its project root. */
  wholeAncestry?: boolean
}

const files = (
  paths: readonly string[],
  mayPickModel: (text: string) => boolean
): ProjectModelFile[] => paths.map((path) => ({ path, mayPickModel }))

// The project files each agent's CLI reads a model from.
const PROJECT_MODEL_LAYERS: Readonly<Record<string, ProjectModelLayers>> = {
  codex: { files: files(['.codex/config.toml'], codexConfigMayPickModel) },
  claude: {
    files: files(
      ['.claude/settings.json', '.claude/settings.local.json'],
      claudeSettingsMayPickModel
    )
  },
  // OpenCode 2.x discovers `opencode.json(c)` and `.opencode/` in every ancestor of the workspace.
  opencode: {
    wholeAncestry: true,
    files: files(
      ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'],
      openCodeConfigMayPickModel
    ),
    agentFolders: [
      { path: '.opencode/agent', recursive: true },
      { path: '.opencode/agents', recursive: true },
      { path: '.opencode/mode', recursive: false },
      { path: '.opencode/modes', recursive: false }
    ]
  },
  // OMP merges its own `.omp` files and these other agents' project settings into its settings.
  omp: {
    files: [
      ...files(
        [
          '.omp/settings.json',
          '.claude/settings.json',
          '.cursor/settings.json',
          '.gemini/settings.json',
          'opencode.json'
        ],
        (text) => ompSettingsMayPickModel(text, 'json')
      ),
      ...files(['.omp/config.yml', '.omp/config.yaml'], (text) =>
        ompSettingsMayPickModel(text, 'yaml')
      ),
      ...files(['.codex/config.toml'], (text) => ompSettingsMayPickModel(text, 'toml'))
    ]
  }
}

function isMissing(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** A missing file is no layer; one that exists but can't be read might pick anything. */
async function fileMayPickModel(
  path: string,
  mayPickModel: (text: string) => boolean
): Promise<boolean> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return !isMissing(error)
  }
  return mayPickModel(text)
}

// More agent files than this are not read one by one; they may pick anything.
const MAX_AGENT_FILES = 200

async function agentFolderMayPickModel(folder: string, recursive: boolean): Promise<boolean> {
  let entries: Dirent[]
  try {
    entries = await readdir(folder, { withFileTypes: true, recursive })
  } catch (error) {
    return !isMissing(error)
  }
  const markdown = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  if (markdown.length > MAX_AGENT_FILES) {
    return true
  }
  const found = await Promise.all(
    markdown.map((entry) =>
      fileMayPickModel(join(entry.parentPath, entry.name), openCodeAgentFileMayPickModel)
    )
  )
  return found.some(Boolean)
}

/** A folder that is the agent's own home is account config, not a layer; any other file or agent
 *  folder setting a model or effort is one. */
async function directoryMayOverride(
  dir: string,
  layers: ProjectModelLayers,
  accountHomePath: string | null
): Promise<boolean> {
  const home = accountHomePath === null ? null : resolve(accountHomePath)
  const found = await Promise.all([
    ...layers.files
      .filter((file) => dirname(join(dir, file.path)) !== home)
      .map((file) => fileMayPickModel(join(dir, file.path), file.mayPickModel)),
    ...(layers.agentFolders ?? []).map((folder) =>
      agentFolderMayPickModel(join(dir, folder.path), folder.recursive)
    )
  ])
  return found.some(Boolean)
}

/** Every directory from the workspace up to the filesystem root. */
function ancestry(cwd: string): string[] {
  const chain: string[] = []
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    chain.push(dir)
    if (dirname(dir) === dir) {
      return chain
    }
  }
}

/** Whether the agent's CLI may read its model from a project's own config. Grok reads its default
 *  model from user, managed and env config only. */
export function agentReadsProjectModelConfig(agent: string): boolean {
  return agent !== 'grok'
}

/** True when a new chat in `workspacePath` could run a model other than the listed default. */
export async function workspaceMayOverrideDefaultModel(input: {
  agent: string
  workspacePath: string
  accountHomePath: string | null
}): Promise<boolean> {
  if (!agentReadsProjectModelConfig(input.agent)) {
    return false
  }
  // An agent whose project layers are not known here may pick another model anywhere.
  const layers = PROJECT_MODEL_LAYERS[input.agent]
  if (!layers) {
    return true
  }
  const dirs = layers.wholeAncestry
    ? ancestry(input.workspacePath)
    : await projectConfigDirectories(input.workspacePath)
  const results = await Promise.all(
    dirs.map((dir) => directoryMayOverride(dir, layers, input.accountHomePath))
  )
  return results.some(Boolean)
}
