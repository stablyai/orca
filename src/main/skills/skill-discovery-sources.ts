import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join, type posix } from 'node:path'
import type {
  DiscoveredSkill,
  SkillDiscoverySource,
  SkillProvider,
  SkillSourceKind
} from '../../shared/skills'
import type { AgentType } from '../../shared/agent-status-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import {
  resolveDefaultHermesSkillsRoot,
  resolveEnvironmentHermesSkillsRoot,
  resolveEnvironmentSkillProviderRoots
} from './skill-provider-runtime-roots'

export type SkillScanRoot = Omit<SkillDiscoverySource, 'exists' | 'skippedReason'>
type SkillDiscoveryPathApi = Pick<typeof posix, 'basename' | 'join'>

export function stablePathId(pathValue: string): string {
  return createHash('sha1').update(pathValue).digest('hex').slice(0, 16)
}

// Skill classification and ordering are identical for native and WSL discovery;
// only the path arithmetic differs (node:path vs pathPosix), so both callers
// share these and pass the matching path adapter.
type SkillRelativePathApi = { relative: (from: string, to: string) => string; sep: string }

export function sourceKindForSkill(
  root: SkillScanRoot,
  skillFilePath: string,
  pathApi: SkillRelativePathApi
): SkillSourceKind {
  if (
    root.sourceKind === 'home' &&
    pathApi.relative(root.path, skillFilePath).split(pathApi.sep)[0] === '.system'
  ) {
    return 'bundled'
  }
  return root.sourceKind
}

export function sourceLabelForSkill(root: SkillScanRoot, sourceKind: SkillSourceKind): string {
  return sourceKind === 'bundled' ? `${root.label} bundled` : root.label
}

export function compareSkills(a: DiscoveredSkill, b: DiscoveredSkill): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.sourceLabel.localeCompare(b.sourceLabel, undefined, { sensitivity: 'base' }) ||
    a.skillFilePath.localeCompare(b.skillFilePath)
  )
}

function source(
  id: string,
  label: string,
  path: string,
  sourceKind: SkillSourceKind,
  providers: SkillProvider[],
  owner: AgentType | null
): SkillScanRoot {
  return { id, label, path, sourceKind, providers, owner }
}

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
  const roots: SkillScanRoot[] = [
    source(
      'home-codex',
      'Codex home',
      pathApi.join(home, '.codex', 'skills'),
      'home',
      ['codex'],
      'codex'
    ),
    source(
      'home-agents',
      'Agent skills home',
      pathApi.join(home, '.agents', 'skills'),
      'home',
      ['agent-skills'],
      null
    ),
    source(
      'home-claude',
      'Claude home',
      providerRootOverrides.claude ?? pathApi.join(home, '.claude', 'skills'),
      'home',
      ['claude'],
      'claude'
    ),
    source(
      'codex-plugin-cache',
      'Codex plugin cache',
      pathApi.join(home, '.codex', 'plugins', 'cache'),
      'plugin',
      ['codex', 'agent-skills'],
      'codex'
    ),
    // Why: `npx skills add --global` writes into each agent's own home skills
    // directory, so coverage misses them unless we scan every provider root.
    source(
      'home-grok',
      'Grok home',
      providerRootOverrides.grok ?? pathApi.join(home, '.grok', 'skills'),
      'home',
      ['agent-skills'],
      'grok'
    ),
    source(
      'home-opencode',
      'OpenCode home',
      pathApi.join(home, '.config', 'opencode', 'skills'),
      'home',
      ['agent-skills'],
      'opencode'
    ),
    source(
      'home-pi',
      'Pi home',
      pathApi.join(home, '.pi', 'agent', 'skills'),
      'home',
      ['agent-skills'],
      'pi'
    ),
    source(
      'home-omp',
      'OMP home',
      pathApi.join(home, '.omp', 'agent', 'skills'),
      'home',
      ['agent-skills'],
      'omp'
    ),
    source('home-hermes', 'Hermes home', hermesSkillsRoot, 'home', ['agent-skills'], 'hermes'),
    source(
      'home-prime-agent',
      'Prime Agent home',
      pathApi.join(home, '.prime', 'agent', 'skills'),
      'home',
      ['agent-skills'],
      'prime-agent'
    ),
    source(
      'home-gemini',
      'Gemini home',
      pathApi.join(home, '.gemini', 'skills'),
      'home',
      ['agent-skills'],
      'gemini'
    ),
    source(
      'home-antigravity',
      'Antigravity home',
      pathApi.join(home, '.gemini', 'antigravity', 'skills'),
      'home',
      ['agent-skills'],
      'antigravity'
    ),
    source(
      'home-cursor',
      'Cursor home',
      pathApi.join(home, '.cursor', 'skills'),
      'home',
      ['agent-skills'],
      'cursor'
    ),
    source(
      'home-droid',
      'Droid home',
      pathApi.join(home, '.factory', 'skills'),
      'home',
      ['agent-skills'],
      'droid'
    ),
    source(
      'home-continue',
      'Continue home',
      pathApi.join(home, '.continue', 'skills'),
      'home',
      ['agent-skills'],
      'continue'
    ),
    source(
      'home-trae',
      'Trae home',
      pathApi.join(home, '.trae-cn', 'skills'),
      'home',
      ['agent-skills'],
      'trae'
    ),
    source(
      'home-aug',
      'Augment home',
      pathApi.join(home, '.augment', 'skills'),
      'home',
      ['agent-skills'],
      'aug'
    )
  ]

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
    const label = `Repo ${pathApi.basename(repoPath)}`
    roots.push(
      source(
        `repo-agents-${stablePathId(repoPath)}`,
        `${label} .agents`,
        pathApi.join(repoPath, '.agents', 'skills'),
        'repo',
        ['agent-skills'],
        null
      ),
      source(
        `repo-claude-${stablePathId(repoPath)}`,
        `${label} .claude`,
        pathApi.join(repoPath, '.claude', 'skills'),
        'repo',
        ['claude'],
        'claude'
      ),
      source(
        `repo-droid-${stablePathId(repoPath)}`,
        `${label} .factory`,
        pathApi.join(repoPath, '.factory', 'skills'),
        'repo',
        ['agent-skills'],
        'droid'
      ),
      source(
        `repo-continue-${stablePathId(repoPath)}`,
        `${label} .continue`,
        pathApi.join(repoPath, '.continue', 'skills'),
        'repo',
        ['agent-skills'],
        'continue'
      ),
      source(
        `repo-trae-${stablePathId(repoPath)}`,
        `${label} .trae`,
        pathApi.join(repoPath, '.trae', 'skills'),
        'repo',
        ['agent-skills'],
        'trae'
      ),
      source(
        `repo-grok-${stablePathId(repoPath)}`,
        `${label} .grok`,
        pathApi.join(repoPath, '.grok', 'skills'),
        'repo',
        ['agent-skills'],
        'grok'
      ),
      source(
        `repo-aug-${stablePathId(repoPath)}`,
        `${label} .augment`,
        pathApi.join(repoPath, '.augment', 'skills'),
        'repo',
        ['agent-skills'],
        'aug'
      )
    )
  }

  return roots
}
