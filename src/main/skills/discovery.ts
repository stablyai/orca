import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Repo } from '../../shared/types'
import {
  SKILL_DISCOVERY_LIMITS,
  type DiscoveredSkill,
  type SkillDiscoveryResult,
  type SkillDiscoverySource
} from '../../shared/skills'
import { buildSkillDiscoverySources, compareSkills } from './skill-discovery-sources'
import { discoverClaudePluginSkillSources } from './claude-plugin-skill-sources'
import { runSkillCandidateTasks } from './skill-candidate-concurrency'
import { scanSkillFile, type ScannedSkill } from './skill-file-scanner'

export { buildSkillDiscoverySources } from './skill-discovery-sources'

const SKILL_FILE_NAME = 'SKILL.md'

/** Node-version-safe alternative to signal.throwIfAborted(); an aborted scan
 *  must reject rather than resolve with partial results. */
function throwIfDiscoveryAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('Skill discovery aborted')
    error.name = 'AbortError'
    throw error
  }
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

function isWithinDepth(rootPath: string, childPath: string, maxDepth: number): boolean {
  const rel = relative(rootPath, childPath)
  if (!rel) {
    return true
  }
  // Why: `..cache` is a valid child name; only a real parent traversal escapes.
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false
  }
  return rel.split(sep).length <= maxDepth
}

async function findSkillFiles(
  rootPath: string,
  maxDepth: number,
  budget: { remaining: number },
  signal?: AbortSignal
): Promise<string[]> {
  const out: string[] = []
  const visitedDirectoryPaths = new Set<string>()
  async function visit(dirPath: string): Promise<void> {
    throwIfDiscoveryAborted(signal)
    if (budget.remaining <= 0) {
      return
    }
    if (!isWithinDepth(rootPath, dirPath, maxDepth)) {
      return
    }
    let resolvedDirPath: string
    try {
      resolvedDirPath = await realpath(dirPath)
    } catch {
      return
    }
    if (visitedDirectoryPaths.has(resolvedDirPath)) {
      return
    }
    visitedDirectoryPaths.add(resolvedDirPath)

    let entries: Dirent[]
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      throwIfDiscoveryAborted(signal)
      if (budget.remaining <= 0) {
        return
      }
      const entryPath = join(dirPath, entry.name)
      if (entry.name === SKILL_FILE_NAME) {
        if (entry.isFile()) {
          budget.remaining -= 1
          out.push(entryPath)
          continue
        }
        if (entry.isSymbolicLink()) {
          try {
            if ((await stat(entryPath)).isFile()) {
              if (budget.remaining <= 0) {
                return
              }
              budget.remaining -= 1
              out.push(entryPath)
            }
          } catch {
            // Broken links are not valid skill files.
          }
        }
        continue
      }
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }
      if (entry.isSymbolicLink()) {
        // Why: users commonly symlink agent skill dirs across providers; follow
        // directory links but guard by realpath so recursive links cannot loop.
        try {
          if ((await stat(entryPath)).isDirectory()) {
            await visit(entryPath)
          }
        } catch {
          // Broken links are not valid skill directories.
        }
      }
    }
  }
  await visit(rootPath)
  return out
}

export async function discoverSkills(args: {
  repos?: Repo[]
  homeDir?: string
  cwd?: string
  includeCwd?: boolean
  signal?: AbortSignal
}): Promise<SkillDiscoveryResult> {
  const signal = args.signal
  throwIfDiscoveryAborted(signal)
  const homeDir = args.homeDir ?? homedir()
  const roots = [
    ...buildSkillDiscoverySources({ ...args, homeDir }),
    // Why: plugin discovery is native-chat data keyed to an explicit workspace.
    // Untargeted scans (Settings) keep their pre-picker inventory and cost.
    ...(args.cwd && args.includeCwd !== false
      ? await discoverClaudePluginSkillSources({ homeDir, cwd: args.cwd })
      : [])
  ]
    .filter((root) => root.path.length <= SKILL_DISCOVERY_LIMITS.pathLength)
    .slice(0, SKILL_DISCOVERY_LIMITS.sources)
  const budget = { remaining: SKILL_DISCOVERY_LIMITS.skills }
  const rootScans = await runSkillCandidateTasks(
    roots.map((root) => async () => {
      throwIfDiscoveryAborted(signal)
      const exists = await pathExists(root.path)
      const maxDepth = root.sourceKind === 'plugin' ? 9 : 4
      const skillFiles = exists ? await findSkillFiles(root.path, maxDepth, budget, signal) : []
      return { root, exists, skillFiles }
    })
  )
  throwIfDiscoveryAborted(signal)
  const sources: SkillDiscoverySource[] = rootScans.map(({ root, exists }) => ({
    ...root,
    providers: [...root.providers],
    exists,
    skippedReason: exists ? undefined : 'missing'
  }))
  const scannedSkills = (
    await runSkillCandidateTasks(
      rootScans.flatMap(({ root, skillFiles }) =>
        skillFiles.map((skillFilePath) => () => scanSkillFile(root, skillFilePath, signal))
      )
    )
  ).filter((skill): skill is ScannedSkill => skill !== null)
  throwIfDiscoveryAborted(signal)
  const seen = new Map<string, DiscoveredSkill>()
  for (const skill of scannedSkills) {
    // Why: overlapping repo/cwd roots and symlinked provider homes can reach
    // the same file. Keep the first source's higher-level scope identity, but
    // record every contributing root so per-agent visibility survives dedup.
    const existing = seen.get(skill.canonicalSkillFilePath)
    if (existing) {
      if (
        existing.rootPaths &&
        existing.rootPaths.length < SKILL_DISCOVERY_LIMITS.rootPaths &&
        !existing.rootPaths.includes(skill.rootPath)
      ) {
        existing.rootPaths.push(skill.rootPath)
      }
      // Why: providers is per-agent visibility just like rootPaths; keeping only
      // the first root's tags makes a shared/symlinked skill under-report which
      // agents can see it on the Settings provider badges/filter. Reassign a
      // fresh array — `providers` aliases the scan root's array, so pushing in
      // place would mutate the root and every sibling skill/source sharing it.
      const mergedProviders = [...existing.providers]
      for (const provider of skill.providers) {
        if (!mergedProviders.includes(provider)) {
          mergedProviders.push(provider)
        }
      }
      existing.providers = mergedProviders
      continue
    }
    const { canonicalSkillFilePath, ...publicSkill } = skill
    seen.set(canonicalSkillFilePath, { ...publicSkill, rootPaths: [skill.rootPath] })
  }
  return {
    skills: Array.from(seen.values()).sort(compareSkills).slice(0, SKILL_DISCOVERY_LIMITS.skills),
    sources: sources.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    ),
    scannedAt: Date.now()
  }
}
