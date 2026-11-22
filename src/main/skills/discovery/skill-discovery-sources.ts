import { homedir } from 'node:os'
import { basename, join, type posix } from 'node:path'
import type {
  SkillDiscoverySource,
  SkillProvider,
  SkillSourceKind
} from '../../../shared/skills/discovery/skills'
import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type { Repo } from '../../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import {
  SKILL_INSTALL_PROVIDERS,
  type SkillInstallProviderId
} from '../../../shared/skills/installation/skill-install-providers'
import type { SkillProviderRootOverrides } from '../providers/skill-provider-destinations'
import { isSkillFolderOwnerOthersRead } from '../../../shared/native-chat/input/commands/native-chat-agent-profiles'
import { stablePathId } from './skill-discovery-classification'
import {
  resolveDefaultHermesSkillsRoot,
  resolveEnvironmentHermesSkillsRoot,
  resolveEnvironmentSkillProviderRoots
} from '../providers/skill-provider-runtime-roots'

export type SkillScanRoot = Omit<SkillDiscoverySource, 'exists' | 'skippedReason'>
type SkillDiscoveryPathApi = Pick<typeof posix, 'basename' | 'join'>

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

// Why: Claude has its own SkillProvider tag; every other agent shares agent-skills.
function skillProvidersFor(id: SkillInstallProviderId): SkillProvider[] {
  return id === 'claude' ? ['claude'] : ['agent-skills']
}

function providerHomeSources(
  home: string,
  pathApi: SkillDiscoveryPathApi,
  overrides: SkillProviderRootOverrides,
  keepsDefaultHomes: boolean
): SkillScanRoot[] {
  return SKILL_INSTALL_PROVIDERS.flatMap((provider) => {
    if (!provider.globalSegments) {
      return []
    }
    const id = `home-${provider.id}`
    const label = `${provider.displayName} home`
    const providers = skillProvidersFor(provider.id)
    const defaultPath = pathApi.join(home, ...provider.globalSegments)
    const relocated = overrides[provider.id]
    if (!relocated || relocated === defaultPath) {
      return [source(id, label, defaultPath, 'home', providers, provider.id)]
    }
    if (!keepsDefaultHomes || !isSkillFolderOwnerOthersRead(provider.id)) {
      return [source(id, label, relocated, 'home', providers, provider.id)]
    }
    // Agents that read this owner's folders join them to the user's home, whatever its override says.
    return [
      { ...source(id, label, relocated, 'home', providers, provider.id), readers: 'owner' },
      {
        ...source(
          `${id}-default`,
          `${label} (default)`,
          defaultPath,
          'home',
          providers,
          provider.id
        ),
        readers: 'borrowers'
      }
    ]
  })
}

function providerRepoSources(
  repoPath: string,
  repoLabel: string,
  pathApi: SkillDiscoveryPathApi
): SkillScanRoot[] {
  return SKILL_INSTALL_PROVIDERS.flatMap((provider) => {
    const segments = provider.workspaceSegments
    if (!segments) {
      return []
    }
    return [
      source(
        `repo-${provider.id}-${stablePathId(repoPath)}`,
        `${repoLabel} ${segments[0]}`,
        pathApi.join(repoPath, ...segments),
        'repo',
        skillProvidersFor(provider.id),
        provider.id
      )
    ]
  })
}

// Project folders these agents also read; they install into the canonical `.agents/skills` root.
const PROJECT_SKILL_FOLDERS: readonly (readonly [AgentType, string, SkillProvider[]])[] = [
  ['codex', '.codex', ['codex']],
  ['cursor', '.cursor', ['agent-skills']],
  ['copilot', '.github', ['agent-skills']],
  ['qoder', '.qoder', ['agent-skills']],
  ['opencode', '.opencode', ['agent-skills']]
]

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
  // Read HERMES_HOME only on this process's host; a custom path adapter describes another host with POSIX Hermes defaults.
  const hermesSkillsRoot = args.pathApi
    ? pathApi.join(home, '.hermes', 'skills')
    : (resolveEnvironmentHermesSkillsRoot() ?? resolveDefaultHermesSkillsRoot({ homeDir: home }))
  const roots: SkillScanRoot[] = [
    // Why: Codex reads `.agents/skills` today; this legacy home still holds older installs.
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
      'codex-plugin-cache',
      'Codex plugin cache',
      pathApi.join(home, '.codex', 'plugins', 'cache'),
      'plugin',
      ['codex', 'agent-skills'],
      'codex'
    ),
    // Provider home roots also receive global npx installs; canonical roots alone miss them.
    // WSL walks each root in the guest, where a relocated home linked to the default one cannot be
    // folded into one scan, so it keeps the relocated root alone.
    ...providerHomeSources(home, pathApi, providerRootOverrides, !args.pathApi),
    // Why: discovery-only agent folders; installs for these agents go to the canonical root.
    source(
      'home-gemini',
      'Gemini CLI home',
      pathApi.join(home, '.gemini', 'skills'),
      'home',
      ['agent-skills'],
      'gemini'
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
    source(
      'home-qoder',
      'Qoder home',
      pathApi.join(home, '.qoder', 'skills'),
      'home',
      ['agent-skills'],
      'qoder'
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
    // Why: Muse installs to `.agents/skills` but also reads XDG config home.
    source(
      'home-muse',
      'Muse home',
      pathApi.join(home, '.config', 'muse', 'skills'),
      'home',
      ['agent-skills'],
      'muse'
    ),
    source(
      'home-copilot',
      'Copilot home',
      pathApi.join(home, '.copilot', 'skills'),
      'home',
      ['agent-skills'],
      'copilot'
    ),
    // Cursor writes its own built-in skills here; they cannot be deleted like a user's.
    source(
      'home-cursor-builtin',
      'Cursor',
      pathApi.join(home, '.cursor', 'skills-cursor'),
      'bundled',
      ['agent-skills'],
      'cursor'
    ),
    // Why: Antigravity also reads its CLI's skill folder beside the `config/skills` install root.
    source(
      'home-antigravity-cli',
      'Antigravity CLI home',
      pathApi.join(home, '.gemini', 'antigravity-cli', 'skills'),
      'home',
      ['agent-skills'],
      'antigravity'
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
      ...providerRepoSources(repoPath, label, pathApi),
      ...PROJECT_SKILL_FOLDERS.map(([owner, folder, providers]) =>
        source(
          `repo-${owner}-${stablePathId(repoPath)}`,
          `${label} ${folder}`,
          pathApi.join(repoPath, folder, 'skills'),
          'repo',
          providers,
          owner
        )
      )
    )
  }

  return roots
}
