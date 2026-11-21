import { join } from 'node:path'
import { stripUnsafeDisplayCharacters } from '../../../shared/text/display-text-safety'
import { stablePathId } from './skill-discovery-classification'
import type { SkillScanRoot } from './skill-discovery-sources'
import { parseSkillMetadataJsonObject, readSkillMetadataFile } from './skill-metadata-json'
import { filterPiManifestRoots, resolveDeclaredPiSkillEntries } from './pi-package-skill-filter'
import {
  resolvePiAgentDir,
  resolvePiPackageRoot,
  type PiPackageScope
} from './pi-package-source-path'

export { resolvePiAgentDir } from './pi-package-source-path'

const PI_MANIFEST_RESOURCE_FIELDS = ['extensions', 'skills', 'prompts', 'themes'] as const

type ParsedPiPackageEntry = {
  source: string
  skills?: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePackageEntries(settingsContent: string | null): ParsedPiPackageEntry[] {
  const settings = parseSkillMetadataJsonObject(settingsContent)
  if (!settings || !Array.isArray(settings.packages)) {
    return []
  }
  const entries: ParsedPiPackageEntry[] = []
  for (const raw of settings.packages) {
    if (typeof raw === 'string' && raw.trim()) {
      entries.push({ source: raw.trim() })
      continue
    }
    if (isRecord(raw)) {
      if (typeof raw.source !== 'string' || !raw.source.trim()) {
        continue
      }
      const skills =
        Array.isArray(raw.skills) && raw.skills.every((item) => typeof item === 'string')
          ? raw.skills
          : undefined
      entries.push({ source: raw.source.trim(), ...(skills ? { skills } : {}) })
    }
  }
  return entries
}

const makePiPackageRoot = (pathValue: string, labelName: string): SkillScanRoot => ({
  id: `pi-package-${stablePathId(pathValue)}`,
  label: `Pi package ${stripUnsafeDisplayCharacters(labelName).slice(0, 80) || 'package'}`,
  path: pathValue,
  sourceKind: 'plugin',
  providers: ['agent-skills'],
  owner: 'pi'
})

async function resolveSkillRootsForPackage(
  packageRoot: string,
  skillsFilter?: readonly string[],
  signal?: AbortSignal
): Promise<string[]> {
  const manifestContent = await readSkillMetadataFile(join(packageRoot, 'package.json'), signal)
  const pkg = parseSkillMetadataJsonObject(manifestContent)
  const piConfig = isRecord(pkg?.pi) ? pkg.pi : null

  const hasManifestResourceFields =
    piConfig !== null &&
    PI_MANIFEST_RESOURCE_FIELDS.some((field) => {
      const value = piConfig[field]
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    })

  const manifestRoots =
    hasManifestResourceFields && piConfig
      ? Array.isArray(piConfig.skills)
        ? await resolveDeclaredPiSkillEntries(packageRoot, piConfig.skills, signal)
        : []
      : [join(packageRoot, 'skills')]

  if (skillsFilter !== undefined) {
    return filterPiManifestRoots(packageRoot, manifestRoots, skillsFilter, signal)
  }
  return manifestRoots
}

export async function discoverPiPackageSkillSources(args: {
  homeDir: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  skipUserSettings?: boolean
  isPathBlocked?: (path: string) => Promise<boolean>
  unavailableOut?: SkillScanRoot[]
  signal?: AbortSignal
}): Promise<SkillScanRoot[]> {
  const piAgentDir = resolvePiAgentDir({ homeDir: args.homeDir, env: args.env })
  const settingsTargets: { scope: PiPackageScope; path: string }[] = []
  if (!args.skipUserSettings) {
    settingsTargets.push({ scope: 'user', path: join(piAgentDir, 'settings.json') })
  }
  if (args.cwd) {
    settingsTargets.push({ scope: 'project', path: join(args.cwd, '.pi', 'settings.json') })
  }

  const contents = await Promise.all(
    settingsTargets.map((target) => readSkillMetadataFile(target.path, args.signal))
  )

  const resolvedPackages = new Map<
    string,
    { packageRoot: string; labelName: string; skillsFilter?: string[] }
  >()

  for (let index = 0; index < settingsTargets.length; index++) {
    const scope = settingsTargets[index].scope
    const entries = parsePackageEntries(contents[index])
    for (const entry of entries) {
      const resolved = resolvePiPackageRoot({
        source: entry.source,
        scope,
        piAgentDir,
        homeDir: args.homeDir,
        cwd: args.cwd
      })
      if (!resolved) {
        continue
      }
      if (entry.skills && entry.skills.length === 0) {
        resolvedPackages.delete(resolved.packageKey)
        continue
      }
      resolvedPackages.set(resolved.packageKey, {
        ...resolved,
        ...(entry.skills ? { skillsFilter: entry.skills } : {})
      })
    }
  }

  const skillRootGroups = await Promise.all(
    [...resolvedPackages.values()].map(async (pkg) => {
      if (args.isPathBlocked && (await args.isPathBlocked(pkg.packageRoot))) {
        args.unavailableOut?.push(makePiPackageRoot(pkg.packageRoot, pkg.labelName))
        return { labelName: pkg.labelName, skillRoots: [] }
      }
      return {
        labelName: pkg.labelName,
        skillRoots: await resolveSkillRootsForPackage(
          pkg.packageRoot,
          pkg.skillsFilter,
          args.signal
        )
      }
    })
  )

  const roots = new Map<string, SkillScanRoot>()
  for (const group of skillRootGroups) {
    for (const skillRootPath of group.skillRoots) {
      if (roots.has(skillRootPath)) {
        continue
      }
      roots.set(skillRootPath, makePiPackageRoot(skillRootPath, group.labelName))
    }
  }

  return [...roots.values()]
}
