import { dirname, join } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { rewriteRelativePathConfigValues } from './codex-config-path-reference-rewrite'
import { normalizeDeprecatedCodexHookFeatureFlag } from './config-toml-deprecated-hook-flag'
import { repairUnparseableCodexConfig } from './codex-config-toml-repair'
import { stripRuntimeOwnedTomlSections } from './config-toml-runtime-owned-sections'

// Why: how ~/.codex is prepared before it is mirrored into an Orca-owned Codex home.

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

export function prepareSystemConfigForRuntimeMirror(
  config: string,
  systemConfigDir: string
): string {
  return rewriteRelativePathConfigValues(
    normalizeDeprecatedCodexHookFeatureFlag(repairUnparseableCodexConfig(config)),
    systemConfigDir
  )
}

// Why: install re-keys ~/.codex user-hook trust; plugin and project hook trust carries as-is.
// Also seeds WSL runtime homes, where systemConfigDir must be the Linux-side
// ~/.codex the config resolves against inside the distro.
export function prepareSystemConfigForFreshRuntimeMirror(
  config: string,
  systemConfigDir: string
): string {
  return stripRuntimeOwnedTomlSections(
    prepareSystemConfigForRuntimeMirror(config, systemConfigDir),
    new Set(),
    { systemHomeDir: systemConfigDir, runtimeHookTrustKeys: new Set() }
  )
}
