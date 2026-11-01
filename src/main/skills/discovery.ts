import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, relative, sep } from 'node:path'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import type { Repo } from '../../shared/repo-types'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoverySource,
  SkillSourceKind
} from '../../shared/skills'
import {
  buildSkillDiscoverySources,
  sortDiscoveredSkills,
  sortSkillDiscoverySources,
  sourceKindForSkill,
  sourceLabelForSkill,
  stablePathId,
  type SkillScanRoot
} from './skill-discovery-sources'
import { rootMayContainSourceKind } from './skill-discovery-source-filter'
import {
  isOnStoppedWslDistro,
  splitStoppedWslDistroRoots,
  stoppedPluginRoot,
  stoppedRootReader,
  unavailableSkillSource,
  type StoppedWslRootsReadScope
} from './skill-discovery-stopped-wsl-roots'
import { wslDistroForPath } from '../wsl/wsl-unc-access-gate'
import { buildRemoteRepoSkillSources } from './skill-remote-repo-sources'
import { discoverClaudePluginSkillSources } from './claude-plugin-skill-sources'
import { findSkillFiles } from './skill-root-file-walk'
import { runSkillCandidateTasks } from './skill-candidate-concurrency'
import {
  isSkillRootUnavailableError,
  SkillScanCoalescer,
  type SkillScanOutcome
} from './skill-scan-coalescer'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import { skillDirectoryMaxDepth } from '../../shared/skill-discovery-depth'

export { buildSkillDiscoverySources } from './skill-discovery-sources'

const MAX_MARKDOWN_BYTES = 256 * 1024
// Share fixed home-root scans across workspace panes to bound repeated filesystem walks.
export const SKILL_ROOT_SCAN_TTL_MS = 10_000
// A scan builds 17 fixed roots + 7/repo + cwd/plugin roots; the cache must hold whole scans or evict itself. Beyond capacity LRU degrades to repeated repo walks.
const MAX_CACHED_SKILL_ROOTS = 1_024
// Cap logged root ids as repos grow; hashed ids avoid exposing names and paths.
export const MAX_LOGGED_ROOT_IDS = 12
// Unavailable roots are unknown, not empty; retain last answers briefly without pinning permanently dead roots.
export const LAST_KNOWN_ROOT_SCAN_RETENTION_MS = 5 * 60_000

type RootScan = { exists: boolean; skills: ScannedSkill[]; unavailable?: boolean }

const rootScans = new SkillScanCoalescer<RootScan>(MAX_CACHED_SKILL_ROOTS)
const lastKnownRootScans = new Map<string, { skills: ScannedSkill[]; recordedAt: number }>()

/** Invalidate after skill mutations. */
export function clearSkillRootScanCache(): void {
  rootScans.clear()
  // Mutation invalidates retained pre-mutation answers too.
  lastKnownRootScans.clear()
}

function recordLastKnownRootScan(key: string, scan: RootScan): void {
  if (!scan.exists) {
    // Confirmed absence invalidates retained skills or a later stall would resurrect deleted entries.
    lastKnownRootScans.delete(key)
    return
  }
  // Reinsert to refresh LRU recency.
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
  const maxDepth = skillDirectoryMaxDepth(root.sourceKind)
  const skillFiles = await findSkillFiles(root.path, maxDepth, signal)
  // Bound per-package metadata fan-out so one large root cannot occupy every core.
  const skills = await runSkillCandidateTasks(
    skillFiles.map((skillFilePath) => async (): Promise<ScannedSkill | null> => {
      // Abandoned walks must stop queued realpath/stat/read work too.
      signal.throwIfAborted()
      // Canonicalize on the scanning host so symlinked roots cannot duplicate picker rows.
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
        // Copy shared root tags before merges so siblings cannot mutate one another.
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

// A path can belong to home and repo roots with different depth; key by sourceKind too.
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
    // One unavailable root must not fail healthy roots. Serve its last answer with explicit uncertainty; an empty list would falsely imply uninstall.
    return {
      value: { exists: true, skills: readLastKnownRootScan(key), unavailable: true },
      cached: false
    }
  }
}

function mergeScannedSkill(seen: Map<string, DiscoveredSkill>, skill: ScannedSkill): void {
  // Deduplicate canonical files but retain every contributing root for per-agent visibility.
  const existing = seen.get(skill.canonicalSkillFilePath)
  if (!existing) {
    const { canonicalSkillFilePath, ...publicSkill } = skill
    // Cached scan objects are shared; copy their arrays into each caller's result.
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
  // Merge all provider tags for visibility, using a fresh array so cached roots and sibling skills stay unchanged.
  const mergedProviders = [...existing.providers]
  for (const provider of skill.providers) {
    if (!mergedProviders.includes(provider)) {
      mergedProviders.push(provider)
    }
  }
  existing.providers = mergedProviders
}

export async function discoverSkills(args: {
  signal?: AbortSignal
  repos?: Repo[]
  homeDir?: string
  cwd?: string
  includeCwd?: boolean
  providerRootOverrides?: SkillProviderRootOverrides
  refresh?: boolean
  names?: string[]
  sourceKinds?: SkillSourceKind[]
  /**
   * A user act (Share) may read stopped WSL distros' folders: 'all', those on named distros, or only
   * the roots holding these skill directories. Every other stopped root is reported unavailable, so
   * its distro stays down.
   */
  readStoppedWslRootsFor?: StoppedWslRootsReadScope
}): Promise<SkillDiscoveryResult> {
  args.signal?.throwIfAborted()
  const startedAt = Date.now()
  const homeDir = args.homeDir ?? homedir()
  const refresh = args.refresh === true
  // Plugin inventory belongs to explicit workspaces; untargeted Settings scans retain their existing scope/cost.
  const pluginCwd =
    args.cwd &&
    args.includeCwd !== false &&
    (!args.sourceKinds?.length || args.sourceKinds.includes('plugin'))
      ? args.cwd
      : undefined
  const gateStopped = args.readStoppedWslRootsFor !== 'all'
  const mayReadStopped = stoppedRootReader(args.readStoppedWslRootsFor)
  const pluginCwdStopped =
    gateStopped &&
    pluginCwd !== undefined &&
    !mayReadStopped(pluginCwd) &&
    wslDistroForPath(pluginCwd) !== null &&
    (await isOnStoppedWslDistro(pluginCwd))
  const candidateRoots = [
    ...buildSkillDiscoverySources({ ...args, homeDir }),
    ...(pluginCwd && !pluginCwdStopped
      ? await waitForPromiseWithSignal(
          discoverClaudePluginSkillSources({ homeDir, cwd: pluginCwd, signal: args.signal }),
          args.signal
        )
      : [])
  ]
  // Host-only root sets never await the WSL gate.
  const { readable, unavailable } =
    gateStopped && candidateRoots.some((root) => wslDistroForPath(root.path))
      ? await splitStoppedWslDistroRoots(candidateRoots, mayReadStopped)
      : { readable: candidateRoots, unavailable: [] }
  const roots = readable.filter((root) => rootMayContainSourceKind(root, args.sourceKinds))
  args.signal?.throwIfAborted()
  const scans = await waitForPromiseWithSignal(
    Promise.all(roots.map((root) => scanRootShared(root, refresh))),
    args.signal
  )
  const sources: SkillDiscoverySource[] = [
    ...roots.map((root, index): SkillDiscoverySource => ({
      ...root,
      providers: [...root.providers],
      exists: scans[index].value.exists,
      skippedReason: scans[index].value.unavailable
        ? 'unavailable'
        : scans[index].value.exists
          ? undefined
          : 'missing'
    })),
    ...(!args.sourceKinds?.length || args.sourceKinds.includes('repo')
      ? buildRemoteRepoSkillSources(args.repos ?? [])
      : []),
    ...[...unavailable, ...(pluginCwd && pluginCwdStopped ? [stoppedPluginRoot(pluginCwd)] : [])]
      .filter((root) => rootMayContainSourceKind(root, args.sourceKinds))
      .map(unavailableSkillSource)
  ]
  const normalizedNames = args.names?.map((name) => name.trim().toLowerCase()).filter(Boolean)
  const expectedNames = normalizedNames?.length ? new Set(normalizedNames) : undefined
  const seen = new Map<string, DiscoveredSkill>()
  for (const { value } of scans) {
    for (const skill of value.skills) {
      if (args.sourceKinds?.length && !args.sourceKinds.includes(skill.sourceKind)) {
        continue
      }
      if (
        expectedNames &&
        !expectedNames.has(skill.name.trim().toLowerCase()) &&
        !expectedNames.has(basename(skill.directoryPath).trim().toLowerCase())
      ) {
        continue
      }
      mergeScannedSkill(seen, skill)
    }
  }
  const skills = sortDiscoveredSkills(Array.from(seen.values()))
  // Log filesystem work only, using hashed root ids rather than private labels/paths.
  const walked = roots.filter((_, index) => !scans[index].cached).map((root) => root.id)
  if (walked.length > 0) {
    // Present-root count distinguishes large root sets from large trees; cap ids as repo count grows.
    const present = sources.filter((source) => source.exists).length
    console.info(
      `[skills] scan roots=${roots.length} present=${present} walked=${walked.length} skills=${skills.length} ms=${Date.now() - startedAt} ids=${walked.slice(0, MAX_LOGGED_ROOT_IDS).join(',')}`
    )
  }
  return {
    skills,
    sources: sortSkillDiscoverySources(sources),
    scannedAt: Date.now()
  }
}
