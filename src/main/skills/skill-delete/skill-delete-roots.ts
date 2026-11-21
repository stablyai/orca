import { homedir } from 'node:os'
import { posix as pathPosix } from 'node:path'
import type { Repo } from '../../../shared/repository/repo-types'
import {
  POSIX_SKILL_PATH_SEMANTICS,
  nativeSkillPathSemantics,
  type SkillPathSemantics
} from '../../../shared/skills/paths/skill-path-containment'
import { toWindowsWslPath } from '../../../shared/file-access/wsl-paths'
import { discoverClaudePluginSkillSources } from '../discovery/claude-plugin-skill-sources'
import { discoverClaudePluginSkillSourcesInWsl } from '../discovery/claude-plugin-skill-sources-wsl'
import { discoverPiPackageSkillSources } from '../discovery/pi-package-skill-sources'
import {
  buildSkillDiscoverySources,
  type SkillScanRoot
} from '../discovery/skill-discovery-sources'
import type { ResolvedSkillDiscoveryTarget } from '../discovery/skill-discovery-target'
import type { SkillProviderRootOverrides } from '../providers/skill-provider-destinations'

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
  const [claudePluginRoots, piPackageRoots] = await Promise.all([
    cwd ? discoverClaudePluginSkillSources({ homeDir: home, cwd }).catch(() => []) : [],
    discoverPiPackageSkillSources({ homeDir: home, ...(cwd ? { cwd } : {}) }).catch(() => [])
  ])
  return {
    roots: [
      // Match discovery's cwd exclusivity and process.cwd fallback; clearing repos alone does not exclude other workspace roots.
      ...buildSkillDiscoverySources({
        homeDir: home,
        ...(cwd ? { cwd } : {}),
        repos: cwd ? [] : [...input.repos],
        providerRootOverrides: input.providerRootOverrides
      }),
      ...claudePluginRoots,
      ...piPackageRoots
    ],
    semantics: nativeSkillPathSemantics(),
    toFilesystemPath: (path) => path
  }
}
