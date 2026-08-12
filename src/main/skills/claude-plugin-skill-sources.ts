import { open, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep, type posix } from 'node:path'
import { stablePathId, type SkillScanRoot } from './skill-discovery-sources'
import { stripUnsafeDisplayCharacters } from '../../shared/skill-display-text'

const MAX_PLUGIN_METADATA_BYTES = 4 * 1024 * 1024

export type SkillDiscoveryPathApi = Pick<
  typeof posix,
  'basename' | 'isAbsolute' | 'join' | 'relative' | 'sep'
>

export type ClaudePluginMetadata = {
  installedPlugins: string | null
  settings: (string | null)[]
}

type ClaudePluginInstall = {
  scope: 'user' | 'project' | 'local'
  installPath: string
  projectPath?: string
  installedAt?: string
  lastUpdated?: string
}

const defaultPathApi: SkillDiscoveryPathApi = { basename, isAbsolute, join, relative, sep }

export function getClaudePluginMetadataPaths(
  homeDir: string,
  cwd: string,
  pathApi: SkillDiscoveryPathApi = defaultPathApi
): { installedPlugins: string; settings: string[] } {
  return {
    installedPlugins: pathApi.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'),
    // Claude merges user, project, then project-local settings in this order.
    settings: [
      pathApi.join(homeDir, '.claude', 'settings.json'),
      pathApi.join(cwd, '.claude', 'settings.json'),
      pathApi.join(cwd, '.claude', 'settings.local.json')
    ]
  }
}

function parseJsonObject(content: string | null): Record<string, unknown> | null {
  if (!content) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(content)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function readEnabledPlugins(settingsContents: readonly (string | null)[]): Map<string, boolean> {
  const enabled = new Map<string, boolean>()
  for (const content of settingsContents) {
    const settings = parseJsonObject(content)
    const configured = settings?.enabledPlugins
    if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
      continue
    }
    for (const [pluginId, value] of Object.entries(configured)) {
      if (typeof value === 'boolean') {
        enabled.set(pluginId, value)
      }
    }
  }
  return enabled
}

function parseInstall(value: unknown): ClaudePluginInstall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    (record.scope !== 'user' && record.scope !== 'project' && record.scope !== 'local') ||
    typeof record.installPath !== 'string'
  ) {
    return null
  }
  return {
    scope: record.scope,
    installPath: record.installPath,
    ...(typeof record.projectPath === 'string' ? { projectPath: record.projectPath } : {}),
    ...(typeof record.installedAt === 'string' ? { installedAt: record.installedAt } : {}),
    ...(typeof record.lastUpdated === 'string' ? { lastUpdated: record.lastUpdated } : {})
  }
}

function isProjectInstallApplicable(
  install: ClaudePluginInstall,
  cwd: string,
  pathApi: SkillDiscoveryPathApi
): boolean {
  if (install.scope === 'user') {
    return true
  }
  if (!install.projectPath || !pathApi.isAbsolute(install.projectPath)) {
    return false
  }
  const relativePath = pathApi.relative(install.projectPath, cwd)
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relativePath))
  )
}

function installPriority(install: ClaudePluginInstall): number {
  return install.scope === 'local' ? 2 : install.scope === 'project' ? 1 : 0
}

function installTimestamp(install: ClaudePluginInstall): number {
  const timestamp = Date.parse(install.lastUpdated ?? install.installedAt ?? '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

function selectActiveInstall(
  values: unknown[],
  cwd: string,
  pathApi: SkillDiscoveryPathApi
): ClaudePluginInstall | null {
  return (
    values
      .map(parseInstall)
      .filter((install): install is ClaudePluginInstall => install !== null)
      .filter(
        (install) =>
          pathApi.isAbsolute(install.installPath) &&
          isProjectInstallApplicable(install, cwd, pathApi)
      )
      .sort(
        (a, b) =>
          installPriority(b) - installPriority(a) ||
          (b.projectPath?.length ?? 0) - (a.projectPath?.length ?? 0) ||
          installTimestamp(b) - installTimestamp(a)
      )[0] ?? null
  )
}

function safePluginLabel(pluginId: string, pathApi: SkillDiscoveryPathApi): string {
  const packageName = pluginId.split('@')[0] || pathApi.basename(pluginId)
  const safeLabel = stripUnsafeDisplayCharacters(packageName).slice(0, 80)
  return safeLabel || 'plugin'
}

export function resolveClaudePluginSkillSources(args: {
  metadata: ClaudePluginMetadata
  cwd: string
  pathApi?: SkillDiscoveryPathApi
}): SkillScanRoot[] {
  const pathApi = args.pathApi ?? defaultPathApi
  const installed = parseJsonObject(args.metadata.installedPlugins)?.plugins
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) {
    return []
  }
  const enabled = readEnabledPlugins(args.metadata.settings)
  const roots = new Map<string, SkillScanRoot>()
  for (const [pluginId, rawInstalls] of Object.entries(installed)) {
    if (enabled.get(pluginId) !== true || !Array.isArray(rawInstalls)) {
      continue
    }
    const install = selectActiveInstall(rawInstalls, args.cwd, pathApi)
    if (!install) {
      continue
    }
    const skillsPath = pathApi.join(install.installPath, 'skills')
    if (!roots.has(skillsPath)) {
      roots.set(skillsPath, {
        id: `claude-plugin-${stablePathId(skillsPath)}`,
        label: `Claude plugin ${safePluginLabel(pluginId, pathApi)}`,
        path: skillsPath,
        sourceKind: 'plugin',
        providers: ['claude'],
        owner: 'claude'
      })
    }
  }
  return [...roots.values()]
}

async function readMetadataFile(pathValue: string): Promise<string | null> {
  try {
    const fileStat = await stat(pathValue)
    if (!fileStat.isFile() || fileStat.size > MAX_PLUGIN_METADATA_BYTES) {
      return null
    }
    const file = await open(pathValue, 'r')
    try {
      const buffer = Buffer.alloc(fileStat.size)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

export async function discoverClaudePluginSkillSources(args: {
  homeDir: string
  cwd: string
}): Promise<SkillScanRoot[]> {
  const paths = getClaudePluginMetadataPaths(args.homeDir, args.cwd)
  const [installedPlugins, ...settings] = await Promise.all(
    [paths.installedPlugins, ...paths.settings].map(readMetadataFile)
  )
  return resolveClaudePluginSkillSources({
    metadata: { installedPlugins, settings },
    cwd: args.cwd
  })
}
