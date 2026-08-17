import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, relative, sep } from 'node:path'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import type { Repo } from '../../shared/repo-types'
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
import {
  isSkillRootUnavailableError,
  SkillScanCoalescer,
  type SkillScanOutcome
} from './skill-scan-coalescer'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'

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
// Why: a root that did not answer holds unknown skills, not zero, so serving what
// it last held is what stops an installed skill flipping to "Install" while a
// mount is wedged. Bounded rather than forever: it covers a stall
// (MAX_JOINABLE_SCAN_AGE_MS) many times over without pinning a permanently dead
// root to rows that can no longer be checked.
export const LAST_KNOWN_ROOT_SCAN_RETENTION_MS = 5 * 60_000

type RootScan = { exists: boolean; skills: ScannedSkill[]; unavailable?: boolean }

const rootScans = new SkillScanCoalescer<RootScan>(MAX_CACHED_SKILL_ROOTS)
/** Last answered scan per root key, read only when a later scan goes unavailable. */
const lastKnownRootScans = new Map<string, { skills: ScannedSkill[]; recordedAt: number }>()

/** Drop every shared root scan, e.g. after a skill install/update mutates disk. */
export function clearSkillRootScanCache(): void {
  rootScans.clear()
  // A mutation invalidates the retained copy too — it is a pre-mutation answer.
  lastKnownRootScans.clear()
}

function recordLastKnownRootScan(key: string, scan: RootScan): void {
  if (!scan.exists) {
    // Why: a root that scanned as absent is known-empty, so keeping an older copy
    // would resurrect skills the user actually removed the next time it stalls.
    lastKnownRootScans.delete(key)
    return
  }
  // Delete first so re-insert refreshes recency under the LRU bound below.
  lastKnownRootScans.delete(key)
  lastKnownRootScans.set(key, { skills: scan.skills, recordedAt: Date.now() })
  while (lastKnownRootScans.size > MAX_CACHED_SKILL_ROOTS) {
    const oldestKey = lastKnownRootScans.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    lastKnownRootScans.delete(oldestKey)
  }
}

function readLastKnownRootScan(key: string): ScannedSkill[] {
  const retained = lastKnownRootScans.get(key)
  if (!retained) {
    return []
  }
  if (Date.now() - retained.recordedAt > LAST_KNOWN_ROOT_SCAN_RETENTION_MS) {
    lastKnownRootScans.delete(key)
    return []
  }
  return retained.skills
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

async function scanRoot(root: SkillScanRoot, signal: AbortSignal): Promise<ScannedSkill[]> {
  const maxDepth = root.sourceKind === 'plugin' ? 9 : 4
  const skillFiles = await findSkillFiles(root.path, maxDepth, signal)
  // Why: a root can hold many packages and each one costs a summary read plus a
  // package walk. Unbounded fan-out here is what turned one scan into a burst of
  // filesystem-metadata work across every core.
  const skills = await runSkillCandidateTasks(
    skillFiles.map((skillFilePath) => async (): Promise<ScannedSkill | null> => {
      // Why: these tasks drain long after the walk, so an abandoned scan would
      // keep spending a realpath + stat + read per remaining candidate.
      signal.throwIfAborted()
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

async function scanRootShared(
  root: SkillScanRoot,
  refresh: boolean
): Promise<SkillScanOutcome<RootScan>> {
  const key = rootScanKey(root)
  try {
    const outcome = await rootScans.run(
      key,
      { ttlMs: SKILL_ROOT_SCAN_TTL_MS, refresh },
      async (signal) => {
        const exists = await pathExists(root.path)
        return { exists, skills: exists ? await scanRoot(root, signal) : [] }
      }
    )
    recordLastKnownRootScan(key, outcome.value)
    return outcome
  } catch (error) {
    if (!isSkillRootUnavailableError(error)) {
      throw error
    }
    // Why degrade instead of rejecting: one unreachable root must not fail the
    // whole discovery and empty the picker for every healthy root beside it.
    // `unavailable` keeps that distinct from a root that genuinely is not there.
    //
    // The abort case matters as much as the shed one: callers already waiting on
    // a scan that is later abandoned for age see it reject, and re-throwing here
    // would turn one slow root into a failed discovery for every root.
    //
    // Empty skills here is not the same claim as `exists: false`: every consumer
    // that derives "installed" does it from the skill list, so shipping an empty
    // one turned an unanswered root into proof the skill is gone. Serve what the
    // root last held and let `unavailable` carry the uncertainty.
    return {
      value: { exists: true, skills: readLastKnownRootScan(key), unavailable: true },
      cached: false
    }
  }
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
  providerRootOverrides?: SkillProviderRootOverrides
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
    skippedReason: scans[index].value.unavailable
      ? 'unavailable'
      : scans[index].value.exists
        ? undefined
        : 'missing'
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
