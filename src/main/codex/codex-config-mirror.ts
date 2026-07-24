import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAgentStateFileSync } from '../agent-state-file-reader'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import { rewriteRelativePathConfigValues } from './codex-config-path-reference-rewrite'
import { normalizeDeprecatedCodexHookFeatureFlag } from './config-toml-deprecated-hook-flag'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  promoteCodexRuntimeSettingsToSystem,
  snapshotCodexRuntimeSettingsBaseline,
  type CodexSettingsPromotionHomes,
  type CodexSettingsPromotionPlan
} from './config-settings-promotion'
import { readCodexSettingsBaseline } from './config-settings-baseline'
import { preserveRuntimeConflictValues } from './codex-config-settings-preservation'
import {
  deduplicateProjectTomlSections,
  getProjectTrustLevel,
  getRevocationTomlSectionHeaderKey,
  getTomlSectionHeaderKey,
  getTomlSections,
  isRuntimePreservedTomlSection,
  isRuntimeProjectTomlSection,
  joinTomlBlocks,
  stripRuntimeOwnedTomlSections
} from './config-toml-runtime-owned-sections'

export function syncSystemConfigIntoManagedCodexHome(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): void {
  // Why: the mirror overwrites runtime settings from ~/.codex, so changes the
  // user made inside Orca-launched Codex (/model, /approvals) must be written
  // back to ~/.codex first or this very pass silently reverts them.
  const promotionPlan = promoteCodexRuntimeSettingsToSystem(homes)
  if (!promotionPlan) {
    // Why: mirroring after a failed write-back would erase the runtime change;
    // leave both runtime and its old baseline intact so the next launch retries.
    return
  }
  let mirrorResult: CodexConfigMirrorResult
  try {
    mirrorResult = syncSystemConfigIntoManagedCodexHomeUnsafe(homes, promotionPlan)
  } catch (error) {
    console.warn('[codex-config] Failed to mirror system Codex config:', error)
    return
  }
  if (mirrorResult.status === 'skipped-missing-source') {
    // Why: advancing an existing baseline would mark the unmirrored runtime
    // change as promoted, so it could never retry once the source reappears.
    // A runtime home seeded outside the mirror (WSL, per-account) has no
    // baseline at all, and promotion stays inert until one exists — bootstrap
    // it, since nothing is promotable yet and so nothing can be stranded.
    if (!readCodexSettingsBaseline(homes.runtimeHomePath)) {
      snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath)
    }
    return
  }
  // Why: the baseline advances only after a successful mirror; recording an
  // unpromoted runtime change as Orca-written would strand it forever.
  snapshotCodexRuntimeSettingsBaseline(
    homes.runtimeHomePath,
    new Map(
      [...promotionPlan.conflicts].filter(([key]) => mirrorResult.preservedConflictKeys.has(key))
    )
  )
}

type CodexConfigMirrorResult =
  | { status: 'skipped-missing-source' }
  | { status: 'mirrored'; preservedConflictKeys: ReadonlySet<string> }

function syncSystemConfigIntoManagedCodexHomeUnsafe(
  { runtimeHomePath, systemHomePath }: CodexSettingsPromotionHomes,
  promotionPlan: CodexSettingsPromotionPlan
): CodexConfigMirrorResult {
  const systemConfigPath = join(systemHomePath, 'config.toml')
  const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
  const systemConfigExists = existsSync(systemConfigPath)
  const runtimeConfigExists = existsSync(runtimeConfigPath)
  const rawSystemConfig = systemConfigExists ? readAgentStateFileSync(systemConfigPath) : ''
  // Why: a missing or blank source is not an authoritative empty config. Merging
  // it would erase every ordinary setting from an existing managed runtime, and
  // a 0-byte file is what a half-written or unhydrated cloud-synced home shows.
  if (rawSystemConfig.trim() === '') {
    return runtimeConfigExists
      ? { status: 'skipped-missing-source' }
      : { status: 'mirrored', preservedConflictKeys: new Set() }
  }

  const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(systemHomePath)
  if (!runtimeConfigExists) {
    writeFileAtomically(
      runtimeConfigPath,
      prepareSystemConfigForFreshRuntimeMirror(rawSystemConfig, sourceConfigDir)
    )
    return { status: 'mirrored', preservedConflictKeys: new Set() }
  }

  const systemConfig = prepareSystemConfigForRuntimeMirror(rawSystemConfig, sourceConfigDir)
  const runtimeConfig = readAgentStateFileSync(runtimeConfigPath)
  const preserved = preserveRuntimeConflictValues(
    mergeSystemCodexConfigIntoRuntime(runtimeConfig, systemConfig),
    promotionPlan.runtimeValuesToPreserve
  )
  if (preserved.content !== runtimeConfig) {
    writeFileAtomically(runtimeConfigPath, preserved.content)
  }
  return { status: 'mirrored', preservedConflictKeys: preserved.keys }
}

export function resolveCodexConfigMirrorSourceDirectory(systemHomePath: string): string {
  return parseWslUncPath(systemHomePath)?.linuxPath ?? dirname(join(systemHomePath, 'config.toml'))
}

function prepareSystemConfigForRuntimeMirror(config: string, systemConfigDir: string): string {
  return rewriteRelativePathConfigValues(
    normalizeDeprecatedCodexHookFeatureFlag(config),
    systemConfigDir
  )
}

// Why: trust blocks reference a hooks.json path, so system-home hook trust
// entries are not valid in a fresh runtime CODEX_HOME until install remaps
// them. Also seeds WSL runtime homes, where systemConfigDir must be the
// Linux-side ~/.codex the config resolves against inside the distro.
export function prepareSystemConfigForFreshRuntimeMirror(
  config: string,
  systemConfigDir: string
): string {
  return stripRuntimeOwnedTomlSections(prepareSystemConfigForRuntimeMirror(config, systemConfigDir))
}

function mergeSystemCodexConfigIntoRuntime(runtimeConfig: string, systemConfig: string): string {
  const runtimeSections = deduplicateProjectTomlSections(getTomlSections(runtimeConfig))
  const runtimeProjectHeaders = new Set(
    runtimeSections
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  const systemProjectSections = deduplicateProjectTomlSections(
    getTomlSections(systemConfig)
  ).filter((section) => isRuntimeProjectTomlSection(section.header))
  const systemUntrustedProjectHeaders = new Set(
    systemProjectSections
      .filter((section) => getProjectTrustLevel(section.block) === 'untrusted')
      .map((section) => getRevocationTomlSectionHeaderKey(section.header))
  )
  // Why: an exact-cased trusted entry in ~/.codex is the user's latest explicit
  // decision for that exact project; a loosely-matched (case-drifted) revocation
  // must not override it, or re-granting trust would be reverted every mirror.
  const systemTrustedProjectHeaders = new Set(
    systemProjectSections
      .filter((section) => getProjectTrustLevel(section.block) === 'trusted')
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  // Why: ordinary Codex settings should mirror ~/.codex exactly; runtime hook
  // trust and project trust are written under Orca's managed CODEX_HOME and
  // must survive the copy unless the user explicitly revoked project trust in
  // the system config.
  return joinTomlBlocks([
    stripRuntimeOwnedTomlSections(systemConfig, runtimeProjectHeaders),
    ...runtimeSections
      .filter((section) => isRuntimePreservedTomlSection(section.header))
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section.header) ||
          !systemUntrustedProjectHeaders.has(getRevocationTomlSectionHeaderKey(section.header)) ||
          systemTrustedProjectHeaders.has(getTomlSectionHeaderKey(section.header))
      )
      .map((section) => section.block)
  ])
}
