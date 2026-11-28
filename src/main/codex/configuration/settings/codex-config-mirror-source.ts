import { dirname, join } from 'node:path'
import { applyCodexDaemonOverride } from '../shared-server/codex-daemon-socket-path-guard'
import { normalizeDeprecatedCodexHookFeatureFlag } from '../toml/config-toml-deprecated-hook-flag'
import { stripRuntimeOwnedTomlSections } from '../toml/config-toml-runtime-owned-sections'
import {
  rebaseBundledMarketplaceSources,
  rewriteRelativePathConfigValues
} from './codex-config-path-reference-rewrite'

// How ~/.codex/config.toml is prepared before the managed mirror merges it.

export function resolveCodexConfigMirrorSourceDirectory(systemHomePath: string): string {
  return dirname(join(systemHomePath, 'config.toml'))
}

export function prepareSystemConfigForRuntimeMirror(
  config: string,
  systemConfigDir: string,
  runtimeHomePath?: string
): string {
  const prepared = rewriteRelativePathConfigValues(
    normalizeDeprecatedCodexHookFeatureFlag(config),
    systemConfigDir
  )
  // WSL guest homes (passed without a runtime home) do not receive host resource links.
  return runtimeHomePath
    ? rebaseBundledMarketplaceSources(prepared, systemConfigDir, runtimeHomePath)
    : prepared
}

// Install re-keys user-hook trust; plugin/project trust carries unchanged.
export function prepareSystemConfigForFreshRuntimeMirror(
  config: string,
  systemConfigDir: string,
  runtimeHomePath?: string
): string {
  return stripRuntimeOwnedTomlSections(
    prepareSystemConfigForRuntimeMirror(config, systemConfigDir, runtimeHomePath),
    new Set(),
    { systemHomeDir: systemConfigDir, runtimeHookTrustKeys: new Set() }
  )
}

/**
 * Why: guard the settings part before runtime tables join it. Hook approvals and project trust are
 * appended after the runtime tables, so a guard re-added at the end made every pass reorder the file.
 * The merge drops a leading BOM anyway; dropping it first lets the guard see a BOM-led features key.
 */
export function guardSystemConfigForRuntimeMerge(
  systemConfig: string,
  runtimeHomePath: string,
  daemonGuarded: boolean
): string {
  return applyCodexDaemonOverride(
    systemConfig.replace(/^\uFEFF/, ''),
    runtimeHomePath,
    daemonGuarded
  )
}
