import { dirname, join } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { rewriteRelativePathConfigValues } from './codex-config-path-reference-rewrite'
import { bindCodexMcpHeaderHelperHome } from './codex-mcp-header-home-binding'
import { normalizeDeprecatedCodexHookFeatureFlag } from './config-toml-deprecated-hook-flag'
import { stripRuntimeOwnedTomlSections } from './config-toml-runtime-owned-sections'

export function prepareSystemConfigForRuntimeMirror(
  config: string,
  systemConfigDir: string,
  runtimeHomePath?: string
): string {
  const normalized = rewriteRelativePathConfigValues(
    normalizeDeprecatedCodexHookFeatureFlag(config),
    systemConfigDir
  )
  return runtimeHomePath
    ? bindCodexMcpHeaderHelperHome(normalized, systemConfigDir, runtimeHomePath)
    : normalized
}

// Why: trust blocks reference a hooks.json path, so system-home hook trust
// entries are not valid in a fresh runtime CODEX_HOME until install remaps
// them. Also seeds WSL runtime homes, where systemConfigDir must be the
// Linux-side ~/.codex the config resolves against inside the distro.
export function prepareSystemConfigForFreshRuntimeMirror(
  config: string,
  systemConfigDir: string,
  runtimeHomePath?: string
): string {
  return stripRuntimeOwnedTomlSections(
    prepareSystemConfigForRuntimeMirror(config, systemConfigDir, runtimeHomePath)
  )
}

export function resolveCodexConfigMirrorSourceDirectory(
  systemHomePath: string,
  systemConfigDir?: string
): string {
  return (
    systemConfigDir ??
    parseWslUncPath(systemHomePath)?.linuxPath ??
    dirname(join(systemHomePath, 'config.toml'))
  )
}
