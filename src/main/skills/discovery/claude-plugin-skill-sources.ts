import { basename, isAbsolute, join, relative, sep, type posix } from 'node:path'
import { stablePathId } from './skill-discovery-classification'
import type { SkillScanRoot } from './skill-discovery-sources'
import { parseSkillMetadataJsonObject, readSkillMetadataFile } from './skill-metadata-json'
import { stripUnsafeDisplayCharacters } from '../../../shared/text/display-text-safety'

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

function readEnabledPlugins(settingsContents: readonly (string | null)[]): Map<string, boolean> {
  const enabled = new Map<string, boolean>()
  for (const content of settingsContents) {
    const settings = parseSkillMetadataJsonObject(content)
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

function safePluginLabel(packageName: string): string {
  const safeLabel = stripUnsafeDisplayCharacters(packageName).slice(0, 80)
  return safeLabel || 'plugin'
}

type ClaudePluginSkillInstall = { root: SkillScanRoot; installPath: string }

type ClaudePluginResolveArgs = {
  metadata: ClaudePluginMetadata
  cwd: string
  pathApi?: SkillDiscoveryPathApi
}

function resolveClaudePluginSkillInstalls(
  args: ClaudePluginResolveArgs
): ClaudePluginSkillInstall[] {
  const pathApi = args.pathApi ?? defaultPathApi
  const installed = parseSkillMetadataJsonObject(args.metadata.installedPlugins)?.plugins
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) {
    return []
  }
  const enabled = readEnabledPlugins(args.metadata.settings)
  const roots = new Map<string, ClaudePluginSkillInstall>()
  for (const [pluginId, rawInstalls] of Object.entries(installed)) {
    if (enabled.get(pluginId) !== true || !Array.isArray(rawInstalls)) {
      continue
    }
    const install = selectActiveInstall(rawInstalls, args.cwd, pathApi)
    if (!install) {
      continue
    }
    const skillsPath = pathApi.join(install.installPath, 'skills')
    // Fallback namespace when the plugin has no manifest name: the `<name>` of `<name>@<marketplace>`.
    const pluginName = pluginId.split('@')[0]
    if (!roots.has(skillsPath)) {
      roots.set(skillsPath, {
        root: {
          id: `claude-plugin-${stablePathId(skillsPath)}`,
          label: `Claude plugin ${safePluginLabel(pluginName || pathApi.basename(pluginId))}`,
          path: skillsPath,
          sourceKind: 'plugin',
          ...(pluginName ? { pluginName } : {}),
          providers: ['claude'],
          owner: 'claude'
        },
        installPath: install.installPath
      })
    }
  }
  return [...roots.values()]
}

export function resolveClaudePluginSkillSources(args: ClaudePluginResolveArgs): SkillScanRoot[] {
  return resolveClaudePluginSkillInstalls(args).map(({ root }) => root)
}

type ClaudePluginDiscoveryArgs = { homeDir: string; cwd: string; signal?: AbortSignal }

export async function discoverClaudePluginSkillInstalls(
  args: ClaudePluginDiscoveryArgs
): Promise<ClaudePluginSkillInstall[]> {
  const paths = getClaudePluginMetadataPaths(args.homeDir, args.cwd)
  const [installedPlugins, ...settings] = await Promise.all(
    [paths.installedPlugins, ...paths.settings].map((path) =>
      readSkillMetadataFile(path, args.signal)
    )
  )
  return resolveClaudePluginSkillInstalls({
    metadata: { installedPlugins, settings },
    cwd: args.cwd
  })
}

export async function discoverClaudePluginSkillSources(
  args: ClaudePluginDiscoveryArgs
): Promise<SkillScanRoot[]> {
  return (await discoverClaudePluginSkillInstalls(args)).map(({ root }) => root)
}

/** Claude namespaces plugin skills by the manifest `name`, which may differ from the plugin id. */
export async function applyClaudePluginManifestNames(
  installs: readonly ClaudePluginSkillInstall[],
  signal?: AbortSignal
): Promise<SkillScanRoot[]> {
  return Promise.all(
    installs.map(async ({ root, installPath }) => {
      const manifest = await readSkillMetadataFile(
        join(installPath, '.claude-plugin', 'plugin.json'),
        signal
      )
      const manifestName = parseSkillMetadataJsonObject(manifest)?.name
      return typeof manifestName === 'string' && manifestName
        ? { ...root, pluginName: manifestName }
        : root
    })
  )
}
