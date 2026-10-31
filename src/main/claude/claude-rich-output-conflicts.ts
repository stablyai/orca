import { open, readdir, stat } from 'node:fs/promises'
import { basename, delimiter, join, resolve } from 'node:path'
import { defaultClaudeConfigDir } from './claude-config-dir-pin'
import { isPlainObject } from '../agent-hooks/hooks-json-read'
import {
  parseClaudePluginInstall,
  readClaudePluginEnablement,
  resolveClaudePluginInstalls
} from '../skills/claude-plugin-skill-sources'

const MAX_METADATA_BYTES = 4 * 1024 * 1024
const MAX_PLUGIN_DIRECTORIES = 1_024

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

async function readMetadata(path: string): Promise<string | null> {
  try {
    const before = await stat(path)
    if (!before.isFile() || before.size > MAX_METADATA_BYTES) {
      throw new Error('Claude plugin metadata is not a bounded regular file')
    }
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) {
        throw new Error('Claude plugin metadata is not a bounded regular file')
      }
      const bytes = Buffer.alloc(stat.size + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > stat.size) {
        throw new Error('Claude plugin metadata changed while reading')
      }
      return bytes.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

function object(content: string | null): Record<string, unknown> | null {
  if (content === null || content.trim() === '') {
    return null
  }
  const value: unknown = JSON.parse(content)
  if (!isPlainObject(value)) {
    throw new Error('Invalid Claude plugin metadata')
  }
  return value
}

async function pluginName(directory: string): Promise<string> {
  const manifest = object(await readMetadata(join(directory, '.claude-plugin', 'plugin.json')))
  return typeof manifest?.name === 'string' ? manifest.name : basename(directory)
}

async function directoryPlugins(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) {
      return []
    }
    throw error
  }
  if (entries.length > MAX_PLUGIN_DIRECTORIES) {
    throw new Error('Too many Claude plugin directories')
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue
    }
    const manifest = object(
      await readMetadata(join(root, entry.name, '.claude-plugin', 'plugin.json'))
    )
    if (typeof manifest?.name === 'string') {
      names.push(manifest.name)
    }
  }
  return names
}

// Reserve disabled copies too: opting into Orca must not bypass a user's plugin choice.
export async function findClaudeRichOutputConflicts(
  env: Record<string, string>,
  cwd: string
): Promise<Set<string>> {
  const configDir = resolve(cwd, defaultClaudeConfigDir(env))
  const [installed, ...settings] = await Promise.all(
    [
      join(configDir, 'plugins', 'installed_plugins.json'),
      join(configDir, 'settings.json'),
      join(cwd, '.claude', 'settings.json'),
      join(cwd, '.claude', 'settings.local.json')
    ].map(readMetadata)
  )
  const installedRecord = object(installed)
  if (
    installedRecord &&
    (typeof installedRecord.version !== 'number' ||
      !Number.isSafeInteger(installedRecord.version) ||
      installedRecord.version < 2 ||
      !isPlainObject(installedRecord.plugins) ||
      Object.values(installedRecord.plugins).some(
        (installs) =>
          !Array.isArray(installs) ||
          installs.some((install) => parseClaudePluginInstall(install) === null)
      ))
  ) {
    throw new Error('Unrecognized Claude plugin install metadata')
  }
  const reserved = new Set<string>()
  const directories = new Set((env.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(delimiter).filter(Boolean))
  for (const content of settings) {
    const setting = object(content)
    const configuredEnv = setting?.env
    if (
      configuredEnv &&
      typeof configuredEnv === 'object' &&
      'CLAUDE_CODE_PLUGIN_DIRS' in configuredEnv
    ) {
      // Let Claude apply its own settings environment without an Orca override.
      reserved.add('reply-markdown')
      reserved.add('reply-media')
    }
  }
  for (const pluginId of readClaudePluginEnablement(settings).keys()) {
    reserved.add(pluginId.split('@')[0])
  }
  for (const install of resolveClaudePluginInstalls({ installedPlugins: installed, cwd })) {
    reserved.add(install.pluginId.split('@')[0])
    directories.add(install.installPath)
  }
  if (directories.size > MAX_PLUGIN_DIRECTORIES) {
    throw new Error('Too many configured Claude plugins')
  }
  for (const directory of directories) {
    reserved.add(await pluginName(resolve(cwd, directory)))
  }
  for (const root of [
    join(configDir, 'skills'),
    join(cwd, '.claude', 'skills'),
    join(configDir, 'plugins', 'synced')
  ]) {
    for (const name of await directoryPlugins(root)) {
      reserved.add(name)
    }
  }
  return reserved
}
