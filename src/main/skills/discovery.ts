import { open, opendir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import type { Repo } from '../../shared/types'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource
} from '../../shared/skills'
import {
  buildSkillDiscoverySources,
  compareSkills,
  sourceKindForSkill,
  sourceLabelForSkill,
  stablePathId,
  type SkillScanRoot
} from './skill-discovery-sources'
import { discoverClaudePluginSkillSources } from './claude-plugin-skill-sources'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  MAX_CONCURRENT_SKILL_DISCOVERY_CANDIDATES,
  MAX_CONCURRENT_SKILL_DISCOVERY_ROOTS,
  MAX_SKILL_PACKAGE_DIRECTORIES,
  MAX_SKILL_PACKAGE_ENTRIES,
  SkillDiscoveryBudget,
  SkillDiscoveryLimitError
} from './skill-discovery-limits'

export { buildSkillDiscoverySources } from './skill-discovery-sources'

const SKILL_FILE_NAME = 'SKILL.md'
const MAX_MARKDOWN_BYTES = 256 * 1024
const MAX_SKILL_FILES = 200

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
  budget: SkillDiscoveryBudget
): Promise<string[]> {
  const out: string[] = []
  const visitedDirectoryPaths = new Set<string>()
  async function visit(dirPath: string): Promise<void> {
    if (!isWithinDepth(rootPath, dirPath, maxDepth)) {
      return
    }
    budget.visitDirectory()
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

    const directory = await opendir(dirPath).catch(() => null)
    if (!directory) {
      return
    }
    try {
      for await (const entry of directory) {
        budget.visitEntry()
        const entryPath = join(dirPath, entry.name)
        if (entry.name === SKILL_FILE_NAME) {
          if (entry.isFile()) {
            budget.admitCandidate()
            out.push(entryPath)
            continue
          }
          if (entry.isSymbolicLink()) {
            const linkedStat = await stat(entryPath).catch(() => null)
            if (linkedStat?.isFile()) {
              budget.admitCandidate()
              out.push(entryPath)
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
          const linkedStat = await stat(entryPath).catch(() => null)
          if (linkedStat?.isDirectory()) {
            await visit(entryPath)
          }
        }
      }
    } catch (error) {
      if (error instanceof SkillDiscoveryLimitError) {
        throw error
      }
    }
  }
  await visit(rootPath)
  return out
}

async function countFiles(dirPath: string): Promise<number> {
  let count = 0
  let entriesVisited = 0
  let stoppedEarly = false
  const visitedDirectoryPaths = new Set<string>()
  async function visit(currentPath: string): Promise<void> {
    if (
      stoppedEarly ||
      count >= MAX_SKILL_FILES ||
      visitedDirectoryPaths.size >= MAX_SKILL_PACKAGE_DIRECTORIES
    ) {
      stoppedEarly = true
      return
    }
    let resolvedPath: string
    try {
      resolvedPath = await realpath(currentPath)
    } catch {
      return
    }
    if (visitedDirectoryPaths.has(resolvedPath)) {
      return
    }
    visitedDirectoryPaths.add(resolvedPath)

    const directory = await opendir(currentPath).catch(() => null)
    if (!directory) {
      return
    }
    try {
      for await (const entry of directory) {
        entriesVisited += 1
        if (count >= MAX_SKILL_FILES || entriesVisited > MAX_SKILL_PACKAGE_ENTRIES) {
          stoppedEarly = true
          return
        }
        const entryPath = join(currentPath, entry.name)
        if (entry.isFile()) {
          count += 1
        } else if (entry.isDirectory()) {
          await visit(entryPath)
        } else if (entry.isSymbolicLink()) {
          try {
            if ((await stat(entryPath)).isFile()) {
              count += 1
            }
          } catch {
            // Broken links do not contribute to the skill package file count.
          }
        }
      }
    } catch {
      // Preserve the partial count when a directory changes during enumeration.
    }
  }
  await visit(dirPath)
  return count
}

async function readSkillSummary(skillFilePath: string): Promise<{
  name: string | null
  description: string | null
  updatedAt: number | null
} | null> {
  try {
    const fileStat = await stat(skillFilePath)
    const file = await open(skillFilePath, 'r')
    let content = ''
    try {
      const buffer = Buffer.alloc(Math.min(fileStat.size, MAX_MARKDOWN_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      content = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
    return {
      ...summarizeSkillMarkdown(content),
      updatedAt: fileStat.mtimeMs
    }
  } catch {
    return null
  }
}

type ScannedSkill = DiscoveredSkill & { canonicalSkillFilePath: string }

async function scanRoot(
  root: SkillScanRoot,
  budget: SkillDiscoveryBudget
): Promise<ScannedSkill[]> {
  const maxDepth = root.sourceKind === 'plugin' ? 9 : 4
  const skillFiles = await findSkillFiles(root.path, maxDepth, budget)
  const skills = await mapWithConcurrency(
    skillFiles,
    MAX_CONCURRENT_SKILL_DISCOVERY_CANDIDATES,
    async (skillFilePath): Promise<ScannedSkill | null> => {
      // Why: path identity belongs to the scanning host; canonicalizing before
      // returning prevents symlinked roots from becoming duplicate picker rows.
      const canonicalSkillFilePath = await realpath(skillFilePath).catch(() => skillFilePath)
      const directoryPath = dirname(skillFilePath)
      const summary = await readSkillSummary(skillFilePath)
      if (!summary) {
        return null
      }
      const sourceKind = sourceKindForSkill(root, skillFilePath, { relative, sep })
      const skill = {
        id: stablePathId(canonicalSkillFilePath),
        name: summary.name ?? basename(directoryPath),
        description: summary.description,
        // Copy: `root.providers` is shared across every skill/source from this
        // root, so the dedup merge below must not mutate the aliased array.
        providers: [...root.providers],
        sourceKind,
        sourceLabel: sourceLabelForSkill(root, sourceKind),
        rootPath: root.path,
        directoryPath,
        skillFilePath,
        installed: true,
        fileCount: await countFiles(directoryPath),
        updatedAt: summary.updatedAt,
        canonicalSkillFilePath
      } satisfies ScannedSkill
      budget.retainSkill(skill)
      return skill
    }
  )
  return skills.filter((skill): skill is ScannedSkill => skill !== null)
}

export async function discoverSkills(args: {
  repos?: Repo[]
  homeDir?: string
  cwd?: string
  includeCwd?: boolean
}): Promise<SkillDiscoveryResult> {
  const homeDir = args.homeDir ?? homedir()
  const roots = [
    ...buildSkillDiscoverySources({ ...args, homeDir }),
    // Why: plugin discovery is native-chat data keyed to an explicit workspace.
    // Untargeted scans (Settings) keep their pre-picker inventory and cost.
    ...(args.cwd && args.includeCwd !== false
      ? await discoverClaudePluginSkillSources({ homeDir, cwd: args.cwd })
      : [])
  ]
  const budget = new SkillDiscoveryBudget(roots)
  const scannedRoots = await mapWithConcurrency(
    roots,
    MAX_CONCURRENT_SKILL_DISCOVERY_ROOTS,
    async (root) => {
      const exists = await pathExists(root.path)
      const source: SkillDiscoverySource = {
        ...root,
        providers: [...root.providers],
        exists,
        skippedReason: exists ? undefined : 'missing'
      }
      if (!exists) {
        return { source, skills: [] }
      }
      return { source, skills: await scanRoot(root, budget) }
    }
  )
  const seen = new Map<string, DiscoveredSkill>()
  for (const group of scannedRoots) {
    for (const skill of group.skills) {
      // Why: overlapping repo/cwd roots and symlinked provider homes can reach
      // the same file. Keep the first source's higher-level scope identity, but
      // record every contributing root so per-agent visibility survives dedup.
      const existing = seen.get(skill.canonicalSkillFilePath)
      if (existing) {
        if (existing.rootPaths && !existing.rootPaths.includes(skill.rootPath)) {
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
  }
  return {
    skills: Array.from(seen.values()).sort(compareSkills),
    sources: scannedRoots
      .map(({ source }) => source)
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
    scannedAt: Date.now()
  }
}
