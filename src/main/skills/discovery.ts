import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, relative, sep } from 'node:path'
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
import { findSkillFiles } from './skill-root-file-walk'
import { runSkillCandidateTasks } from './skill-candidate-concurrency'
import { SkillScanCoalescer, type SkillScanOutcome } from './skill-scan-coalescer'

export { buildSkillDiscoverySources } from './skill-discovery-sources'

const MAX_MARKDOWN_BYTES = 256 * 1024
// Why: the fixed home roots are identical for every target, so one worktree pane
// per open workspace used to re-walk the same directories once per pane. Sharing
// them for a few seconds is what bounds that fan-out.
export const SKILL_ROOT_SCAN_TTL_MS = 10_000
// Why: sized off the root formula, not a round number. One scan builds
// `12 fixed home roots + 2 per local repo (+ cwd) + plugin roots`, so a bound
// smaller than a single scan's root count makes that scan evict its own earlier
// entries and the cache degrades to a ~0% hit rate — exactly the walk this
// exists to prevent. The live key space is the union across targets — the fixed
// home roots plus two per repo plus two per distinct workspace cwd — so this holds
// a few hundred repos with panes open, not an unbounded install. Past that the LRU
// keeps the hot home roots and the repo roots thrash, which degrades rather than
// breaks. Most repo roots do not exist, and a missing root caches as
// `{exists: false, skills: []}`.
const MAX_CACHED_SKILL_ROOTS = 1_024
// Why: roots grow with the repo count, so an uncapped id list would make one log
// line grow with the install. Root *ids* are safe to log where labels and paths
// are not — a repo/plugin id is already a hash.
export const MAX_LOGGED_ROOT_IDS = 12

type RootScan = { exists: boolean; skills: ScannedSkill[] }

const rootScans = new SkillScanCoalescer<RootScan>(MAX_CACHED_SKILL_ROOTS)

/** Drop every shared root scan, e.g. after a skill install/update mutates disk. */
export function clearSkillRootScanCache(): void {
  rootScans.clear()
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
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

async function scanRoot(root: SkillScanRoot): Promise<ScannedSkill[]> {
  const maxDepth = root.sourceKind === 'plugin' ? 9 : 4
  const skillFiles = await findSkillFiles(root.path, maxDepth)
  // Why: a root can hold many packages and each one costs a summary read plus a
  // package walk. Unbounded fan-out here is what turned one scan into a burst of
  // filesystem-metadata work across every core.
  const skills = await runSkillCandidateTasks(
    skillFiles.map((skillFilePath) => async (): Promise<ScannedSkill | null> => {
      // Why: path identity belongs to the scanning host; canonicalizing before
      // returning prevents symlinked roots from becoming duplicate picker rows.
      const canonicalSkillFilePath = await realpath(skillFilePath).catch(() => skillFilePath)
      const directoryPath = dirname(skillFilePath)
      const summary = await readSkillSummary(skillFilePath)
      if (!summary) {
        return null
      }
      const sourceKind = sourceKindForSkill(root, skillFilePath, { relative, sep })
      return {
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
        updatedAt: summary.updatedAt,
        canonicalSkillFilePath
      } satisfies ScannedSkill
    })
  )
  return skills.filter((skill): skill is ScannedSkill => skill !== null)
}

// Why: two roots can share a path (e.g. `~/.claude/skills` is both a home root
// and a repo root when the home dir is the workspace), and their scan differs
// only by depth, which `sourceKind` decides.
function rootScanKey(root: SkillScanRoot): string {
  return `${root.sourceKind}\0${root.path}`
}

function scanRootShared(
  root: SkillScanRoot,
  refresh: boolean
): Promise<SkillScanOutcome<RootScan>> {
  return rootScans.run(rootScanKey(root), { ttlMs: SKILL_ROOT_SCAN_TTL_MS, refresh }, async () => {
    const exists = await pathExists(root.path)
    return { exists, skills: exists ? await scanRoot(root) : [] }
  })
}

function mergeScannedSkill(seen: Map<string, DiscoveredSkill>, skill: ScannedSkill): void {
  // Why: overlapping repo/cwd roots and symlinked provider homes can reach
  // the same file. Keep the first source's higher-level scope identity, but
  // record every contributing root so per-agent visibility survives dedup.
  const existing = seen.get(skill.canonicalSkillFilePath)
  if (!existing) {
    const { canonicalSkillFilePath, ...publicSkill } = skill
    // Copy: a shared root scan hands the same skill object to every caller, so the
    // result each one owns must not alias the cached arrays.
    seen.set(canonicalSkillFilePath, {
      ...publicSkill,
      providers: [...publicSkill.providers],
      rootPaths: [skill.rootPath]
    })
    return
  }
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
}

export async function discoverSkills(args: {
  repos?: Repo[]
  homeDir?: string
  cwd?: string
  includeCwd?: boolean
  refresh?: boolean
}): Promise<SkillDiscoveryResult> {
  const startedAt = Date.now()
  const homeDir = args.homeDir ?? homedir()
  const refresh = args.refresh === true
  const roots = [
    ...buildSkillDiscoverySources({ ...args, homeDir }),
    // Why: plugin discovery is native-chat data keyed to an explicit workspace.
    // Untargeted scans (Settings) keep their pre-picker inventory and cost.
    ...(args.cwd && args.includeCwd !== false
      ? await discoverClaudePluginSkillSources({ homeDir, cwd: args.cwd })
      : [])
  ]
  const scans = await Promise.all(roots.map((root) => scanRootShared(root, refresh)))
  const sources: SkillDiscoverySource[] = roots.map((root, index) => ({
    ...root,
    providers: [...root.providers],
    exists: scans[index].value.exists,
    skippedReason: scans[index].value.exists ? undefined : 'missing'
  }))
  const seen = new Map<string, DiscoveredSkill>()
  for (const { value } of scans) {
    for (const skill of value.skills) {
      mergeScannedSkill(seen, skill)
    }
  }
  const skills = Array.from(seen.values()).sort(compareSkills)
  // Why: root *ids* — a repo/plugin id is already a hash, while its label carries
  // the repo or plugin name and its path carries the user's directory names. A
  // fully cached scan did no filesystem work, so it stays silent rather than
  // burying the bursts this line exists to make visible.
  const walked = roots.filter((_, index) => !scans[index].cached).map((root) => root.id)
  if (walked.length > 0) {
    // `present` is not derivable from the rest: "walked 500 roots, 3 existed" is
    // the shape that says the root set, not the tree, is what costs. The id list
    // is capped because roots grow with the repo count.
    const present = sources.filter((source) => source.exists).length
    console.info(
      `[skills] scan roots=${roots.length} present=${present} walked=${walked.length} skills=${skills.length} ms=${Date.now() - startedAt} ids=${walked.slice(0, MAX_LOGGED_ROOT_IDS).join(',')}`
    )
  }
  return {
    skills,
    sources: sources.sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    ),
    scannedAt: Date.now()
  }
}
