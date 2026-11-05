import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  claudeSettingsModelOverride,
  codexConfigModelOverride,
  ompSettingsMayPickModel,
  openCodeAgentFileMayPickModel,
  openCodeConfigMayPickModel,
  piSettingsMayPickModel,
  type ProjectModelOverride
} from './agent-project-model-config-keys'

export type { ProjectModelOverride }

// Project model/effort settings invalidate the account default without resolving a replacement.

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isProjectRoot(dir: string): Promise<boolean> {
  const git = join(dir, '.git')
  try {
    const entry = await stat(git)
    return entry.isFile() || (await exists(join(git, 'HEAD')))
  } catch {
    return false
  }
}

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
  /** One parse answers both questions. */
  override: (text: string) => ProjectModelOverride
}

type ProjectModelLayers = {
  files: readonly ProjectModelFile[]
  agentFolders?: readonly { path: string; recursive: boolean }[]
  codeFolders?: readonly string[]
  /** Include ancestors above the project root. */
  wholeAncestry?: boolean
}

const both = (value: boolean): ProjectModelOverride => ({ model: value, effort: value })

const files = (
  paths: readonly string[],
  override: ProjectModelFile['override']
): ProjectModelFile[] => paths.map((path) => ({ path, override }))

/** Agents whose settings can't separate model from effort pick both or neither. */
const sameForBoth =
  (mayPickModel: (text: string) => boolean): ProjectModelFile['override'] =>
  (text) =>
    both(mayPickModel(text))

// OpenCode 2.x reads every ancestor, including above the nearest .git root.
const OPENCODE_PROJECT_MODEL_LAYERS: ProjectModelLayers = {
  wholeAncestry: true,
  files: files(
    ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'],
    sameForBoth(openCodeConfigMayPickModel)
  ),
  agentFolders: [
    { path: '.opencode/agent', recursive: true },
    { path: '.opencode/agents', recursive: true },
    { path: '.opencode/mode', recursive: false },
    { path: '.opencode/modes', recursive: false }
  ]
}

const PROJECT_MODEL_LAYERS: Readonly<Record<string, ProjectModelLayers>> = {
  codex: { files: files(['.codex/config.toml'], codexConfigModelOverride) },
  claude: {
    files: files(
      ['.claude/settings.json', '.claude/settings.local.json'],
      claudeSettingsModelOverride
    )
  },
  opencode: OPENCODE_PROJECT_MODEL_LAYERS,
  opencode2: OPENCODE_PROJECT_MODEL_LAYERS,
  // OMP also merges other agents' project settings.
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
        sameForBoth((text) => ompSettingsMayPickModel(text, 'json'))
      ),
      ...files(
        ['.omp/config.yml', '.omp/config.yaml'],
        sameForBoth((text) => ompSettingsMayPickModel(text, 'yaml'))
      ),
      ...files(
        ['.codex/config.toml'],
        sameForBoth((text) => ompSettingsMayPickModel(text, 'toml'))
      )
    ]
  },
  pi: {
    files: files(['.pi/settings.json'], sameForBoth(piSettingsMayPickModel)),
    codeFolders: ['.pi/extensions']
  }
}

function isMissing(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : null
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const either = (found: ProjectModelOverride[]): ProjectModelOverride => ({
  model: found.some((entry) => entry.model),
  effort: found.some((entry) => entry.effort)
})

/** Unreadable files may override defaults; absent files cannot. One read answers both questions. */
async function fileMayPickModel(
  path: string,
  override: ProjectModelFile['override']
): Promise<ProjectModelOverride> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return both(!isMissing(error))
  }
  return override(text)
}

// Bound reads; catalogs over the cap remain conservatively capable of overriding defaults.
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
      fileMayPickModel(
        join(entry.parentPath, entry.name),
        sameForBoth(openCodeAgentFileMayPickModel)
      )
    )
  )
  return found.some((entry) => entry.effort)
}

/** Non-dotfile extension content can change models arbitrarily. */
async function codeFolderMayPickModel(folder: string): Promise<boolean> {
  try {
    return (await readdir(folder)).some((name) => !name.startsWith('.'))
  } catch (error) {
    return !isMissing(error)
  }
}

/** Exclude account-home config already covered by CLI resolution. */
async function directoryMayOverride(
  dir: string,
  layers: ProjectModelLayers,
  accountHomePath: string | null
): Promise<ProjectModelOverride> {
  const home = accountHomePath === null ? null : resolve(accountHomePath)
  const found = await Promise.all([
    ...layers.files
      .filter((file) => dirname(join(dir, file.path)) !== home)
      .map((file) => fileMayPickModel(join(dir, file.path), file.override)),
    ...(layers.agentFolders ?? []).map(async (folder) =>
      both(await agentFolderMayPickModel(join(dir, folder.path), folder.recursive))
    ),
    ...(layers.codeFolders ?? [])
      .filter((folder) => dirname(join(dir, folder)) !== home)
      .map(async (folder) => both(await codeFolderMayPickModel(join(dir, folder))))
  ])
  return either(found)
}

function ancestry(cwd: string): string[] {
  const chain: string[] = []
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    chain.push(dir)
    if (dirname(dir) === dir) {
      return chain
    }
  }
}

// Grok uses user, managed and environment config, not project model settings.
export function agentReadsProjectModelConfig(agent: string): boolean {
  return agent !== 'grok'
}

export async function workspaceMayOverrideDefaultModel(input: {
  agent: string
  workspacePath: string
  accountHomePath: string | null
}): Promise<ProjectModelOverride> {
  if (!agentReadsProjectModelConfig(input.agent)) {
    return both(false)
  }
  // Unknown project layers may override defaults anywhere.
  const layers = PROJECT_MODEL_LAYERS[input.agent]
  if (!layers) {
    return both(true)
  }
  const dirs = layers.wholeAncestry
    ? ancestry(input.workspacePath)
    : await projectConfigDirectories(input.workspacePath)
  return either(
    await Promise.all(dirs.map((dir) => directoryMayOverride(dir, layers, input.accountHomePath)))
  )
}
