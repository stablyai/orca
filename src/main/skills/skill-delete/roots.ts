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

/** Rebuild roots from target, repos and provider overrides on the delete host; trusting client roots could authorize out-of-root deletion. */
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
    const { distro, homeDir } = input.target
    const cwd = input.target.cwd ?? homeDir
    return {
      roots: [
        ...buildSkillDiscoverySources({
          homeDir,
          cwd,
          repos: [],
          pathApi: pathPosix,
          providerRootOverrides: input.providerRootOverrides
        }),
        // Plugin metadata only enriches roots; read failure must not mark every skill unowned.
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
      // Match discovery's cwd exclusivity and process.cwd fallback; clearing repos alone does not exclude other workspace roots.
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
