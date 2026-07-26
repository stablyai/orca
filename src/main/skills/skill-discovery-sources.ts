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
import type { Repo } from '../../shared/types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

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
  } = {}
): SkillScanRoot[] {
  const pathApi = args.pathApi ?? { basename, join }
  const home = args.homeDir ?? homedir()
  const cwd = args.cwd ?? process.cwd()
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
      pathApi.join(home, '.claude', 'skills'),
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
      pathApi.join(home, '.grok', 'skills'),
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
      )
    )
  }

  return roots
}
