import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Repo } from '../../shared/types'
import type {
  SkillFreshnessInstallation,
  SkillFreshnessInventory
} from '../../shared/skill-freshness'
import { buildSkillDiscoverySources, type SkillScanRoot } from './skill-discovery-sources'
import { loadSkillBundleArtifacts } from './skill-bundle-artifacts'
import { eligibleSkillUpdateNames } from './skill-freshness-eligibility'
import { runSkillCandidateTasks } from './skill-candidate-concurrency'
import {
  classifyHomeSkillCandidate,
  classifyUnsupportedSkillCandidate,
  dedupeSkillFreshnessPlacements,
  observeSkillFreshnessInstallation,
  type CandidateLstat
} from './skill-freshness-placement-observation'
import { scanKnownPluginSkillCandidates } from './skill-plugin-cache-scan'

export const MAXIMUM_REPOSITORY_SKILL_ROOTS = 128

export function boundRepositorySkillRoots(roots: readonly SkillScanRoot[]): {
  scanned: SkillScanRoot[]
  omitted: SkillScanRoot[]
} {
  return {
    scanned: roots.slice(0, MAXIMUM_REPOSITORY_SKILL_ROOTS),
    omitted: roots.slice(MAXIMUM_REPOSITORY_SKILL_ROOTS)
  }
}

export async function inventorySkillFreshness(
  args: {
    homeDir?: string
    cwd?: string
    repos?: Repo[]
    resourceRoot?: string
    candidateLstat?: CandidateLstat
  } = {}
): Promise<SkillFreshnessInventory> {
  const artifacts = await loadSkillBundleArtifacts(args.resourceRoot)
  const currentByName = new Map(artifacts.manifest.skills.map((skill) => [skill.name, skill]))
  const discoveryArgs = {
    homeDir: args.homeDir,
    cwd: args.cwd,
    repos: args.repos,
    // Why: freshness scans known repositories explicitly; treating the app's
    // launch cwd as another repo would create phantom poison placements.
    includeCwd: false
  }
  const roots = buildSkillDiscoverySources(discoveryArgs)
  const homeRoots = roots.filter((root) => root.sourceKind === 'home')
  const allRepoRoots = roots.filter((root) => root.sourceKind === 'repo')
  const { scanned: repoRoots, omitted: omittedRepoRoots } = boundRepositorySkillRoots(allRepoRoots)
  const pluginRoots = roots.filter((root) => root.sourceKind === 'plugin')
  const canonicalRootPath = homeRoots.find((root) => root.id === 'home-agents')?.path
  if (!canonicalRootPath) {
    throw new Error('Missing canonical agent skills root')
  }

  const homeTasks = artifacts.manifest.skills.flatMap((current) =>
    homeRoots.map(
      (root) => () =>
        classifyHomeSkillCandidate({
          root,
          current,
          artifacts,
          canonicalRootPath,
          candidateLstat: args.candidateLstat ?? ((path) => lstat(path))
        })
    )
  )
  // Why: each observation may retain the package byte ceiling while hashing;
  // launch/focus scans must not fan out across every known placement.
  const homeInstallations = (await runSkillCandidateTasks(homeTasks)).filter(
    (installation): installation is SkillFreshnessInstallation => installation !== null
  )

  const candidateLstat = args.candidateLstat ?? ((path) => lstat(path))
  const repoTasks = artifacts.manifest.skills.flatMap((current) =>
    repoRoots.map(
      (root) => () =>
        classifyUnsupportedSkillCandidate({
          root,
          current,
          artifacts,
          unresolvedPath: join(root.path, current.name),
          candidateLstat
        })
    )
  )
  // Why: stored repositories can grow without bound. If the probe budget is
  // exhausted, one sentinel per name preserves safety without hashing more packages.
  const omittedRepoTasks =
    omittedRepoRoots.length === 0
      ? []
      : artifacts.manifest.skills.map(
          (current) => () =>
            observeSkillFreshnessInstallation({
              current,
              artifacts,
              rootId: 'repo-scan-limit',
              providers: [...new Set(omittedRepoRoots.flatMap((root) => root.providers))],
              sourceKind: 'repo',
              sourceLabel: 'Additional repositories',
              unresolvedPath: omittedRepoRoots[0]?.path ?? 'repo-scan-limit',
              topology: {
                topology: 'repo-scope',
                resolvedPath: null,
                identity: null,
                errorCategory: 'repository-scan-limit'
              }
            })
        )
  const pluginScans = await Promise.all(
    pluginRoots.map(async (root) => ({
      root,
      scan: await scanKnownPluginSkillCandidates(root.path, new Set(currentByName.keys()))
    }))
  )
  const pluginTasks = pluginScans.flatMap(({ root, scan }) => [
    ...scan.candidates.flatMap((candidate) => {
      const current = currentByName.get(candidate.name)
      return current
        ? [
            () =>
              classifyUnsupportedSkillCandidate({
                root,
                current,
                artifacts,
                unresolvedPath: candidate.path,
                candidateLstat
              })
          ]
        : []
    }),
    // Why: unreadable plugin subtrees could hide any official name. An
    // incomplete scan must conservatively poison every name rather than imply absence.
    ...scan.incompletePaths.flatMap((incompletePath) =>
      artifacts.manifest.skills.map(
        (current) => () =>
          observeSkillFreshnessInstallation({
            current,
            artifacts,
            rootId: root.id,
            providers: root.providers,
            sourceKind: 'plugin',
            sourceLabel: root.label,
            unresolvedPath: join(incompletePath, current.name),
            topology: {
              topology: 'plugin-cache',
              resolvedPath: null,
              identity: null,
              errorCategory: 'plugin-cache-scan-incomplete'
            }
          })
      )
    )
  ])
  const unsupportedInstallations = (
    await runSkillCandidateTasks([...repoTasks, ...omittedRepoTasks, ...pluginTasks])
  ).filter((installation): installation is SkillFreshnessInstallation => installation !== null)
  const installations = dedupeSkillFreshnessPlacements([
    ...homeInstallations,
    ...unsupportedInstallations
  ]).sort(
    (left, right) =>
      left.name.localeCompare(right.name, 'en') ||
      left.unresolvedPath.localeCompare(right.unresolvedPath, 'en')
  )

  return {
    schemaVersion: 1,
    installations,
    eligibleUpdateNames: eligibleSkillUpdateNames(installations),
    scannedAt: Date.now()
  }
}
