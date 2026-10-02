import { homedir } from 'node:os'
import { basename, join, type posix } from 'node:path'
import {
  buildAgentSkillHomeRoots,
  buildAgentSkillRepoRoots,
  type AgentSkillScanRoot
} from '../../shared/agent-skill-scan-roots'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import {
  resolveDefaultHermesSkillsRoot,
  resolveEnvironmentHermesSkillsRoot,
  resolveEnvironmentSkillProviderRoots
} from './skill-provider-runtime-roots'

export type SkillScanRoot = AgentSkillScanRoot

// Re-exported so existing importers keep one entry point for discovery helpers.
export {
  sortDiscoveredSkills,
  sortSkillDiscoverySources,
  sourceKindForSkill,
  sourceLabelForSkill,
  stablePathId
} from './skill-discovery-classification'
type SkillDiscoveryPathApi = Pick<typeof posix, 'basename' | 'join'>

export function buildSkillDiscoverySources(
  args: {
    homeDir?: string
    cwd?: string
    repos?: Repo[]
    includeCwd?: boolean
    pathApi?: SkillDiscoveryPathApi
    providerRootOverrides?: SkillProviderRootOverrides
  } = {}
): SkillScanRoot[] {
  const pathApi = args.pathApi ?? { basename, join }
  const home = args.homeDir ?? homedir()
  const cwd = args.cwd ?? process.cwd()
  const providerRootOverrides =
    args.providerRootOverrides ?? (args.pathApi ? {} : resolveEnvironmentSkillProviderRoots())
  // Why: HERMES_HOME moves the whole profile tree, so the default home path
  // finds nothing for `hermes -p <profile>`. Only this process's own host can
  // read it — a custom pathApi means the home belongs to another host, whose
  // Hermes install is POSIX-shaped even when this process runs on Windows.
  const hermesSkillsRoot = args.pathApi
    ? pathApi.join(home, '.hermes', 'skills')
    : (resolveEnvironmentHermesSkillsRoot() ?? resolveDefaultHermesSkillsRoot({ homeDir: home }))
  const roots: SkillScanRoot[] = buildAgentSkillHomeRoots({
    home,
    hermesSkillsRoot,
    pathApi,
    providerRootOverrides
  })

  const projectPaths = new Set<string>()
  for (const repo of args.repos ?? []) {
    // Why: runtime-owned repos can have no legacy connectionId while their
    // paths are meaningful only on a remote host.
    if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    projectPaths.add(repo.path)
  }
  if (args.includeCwd !== false) {
    projectPaths.add(cwd)
  }

  for (const repoPath of projectPaths) {
    roots.push(...buildAgentSkillRepoRoots(repoPath, pathApi))
  }

  return roots
}
