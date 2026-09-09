import { homedir } from 'node:os'
import { posix as pathPosix } from 'node:path'
import type { Repo } from '../../../shared/repo-types'
import {
  POSIX_SKILL_PATH_SEMANTICS,
  nativeSkillPathSemantics,
  type SkillPathSemantics
} from '../../../shared/skill-path-containment'
import { toWindowsWslPath } from '../../../shared/wsl-paths'
import { discoverClaudePluginSkillSources } from '../claude-plugin-skill-sources'
import { discoverClaudePluginSkillSourcesInWsl } from '../claude-plugin-skill-sources-wsl'
import { buildSkillDiscoverySources, type SkillScanRoot } from '../skill-discovery-sources'
import type { ResolvedSkillDiscoveryTarget } from '../skill-discovery-target'
import type { SkillProviderRootOverrides } from '../skill-provider-destinations'

/**
 * The delete host owns everything about where skills may live, so it rebuilds
 * the discovery root set from the same three inputs `discoverSkillsOnTarget`
 * uses — target, repo list, provider-root overrides. Rebuilding beats trusting
 * the client: the worst case is a refusal, never a delete outside a root.
 */
export type SkillDeleteRootSet = {
  roots: SkillScanRoot[]
  semantics: SkillPathSemantics
  /** Translates a host-owned path into the spelling the filesystem accepts. */
  toFilesystemPath: (path: string) => string
}

export async function buildSkillDeleteRootSet(input: {
  target: ResolvedSkillDiscoveryTarget
  repos: readonly Repo[]
  providerRootOverrides?: SkillProviderRootOverrides
  homeDir?: string
}): Promise<SkillDeleteRootSet> {
  if (input.target.kind === 'wsl') {
    const { distro, homeDir, cwd } = input.target
    return {
      roots: [
        ...buildSkillDiscoverySources({
          homeDir,
          cwd,
          repos: [],
          pathApi: pathPosix,
          providerRootOverrides: input.providerRootOverrides
        }),
        // Why tolerated: plugin metadata is enrichment. A failed read must not
        // turn every skill on the host into `unowned`.
        ...(await discoverClaudePluginSkillSourcesInWsl({ distro, homeDir, cwd }).catch(() => []))
      ],
      // A WSL runtime is POSIX and case-sensitive even though the process is win32.
      semantics: POSIX_SKILL_PATH_SEMANTICS,
      toFilesystemPath: (path) => toWindowsWslPath(path, distro)
    }
  }

  const home = input.homeDir ?? homedir()
  const cwd = input.target.cwd
  return {
    roots: [
      // Mirrors `discoverSkillsOnTarget`: a cwd-scoped scan drops the repo list,
      // and `buildSkillDiscoverySources` adds `cwd ?? process.cwd()` on top
      // either way, so `repos: []` is not the whole exclusivity rule by itself.
      ...buildSkillDiscoverySources({
        homeDir: home,
        ...(cwd ? { cwd } : {}),
        repos: cwd ? [] : [...input.repos],
        providerRootOverrides: input.providerRootOverrides
      }),
      ...(cwd ? await discoverClaudePluginSkillSources({ homeDir: home, cwd }).catch(() => []) : [])
    ],
    semantics: nativeSkillPathSemantics(),
    toFilesystemPath: (path) => path
  }
}
