import { readMcpServerTomlOwnership } from './config-toml-mcp-servers'
import { join } from 'node:path'
import { observeAgentStateFile } from './codex-path-observation'
import { writeFileAtomically, writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import {
  promoteCodexRuntimeSettingsToSystem,
  snapshotCodexRuntimeSettingsBaseline,
  type CodexSettingsPromotionHomes,
  type CodexSettingsPromotionPlan
} from './config-settings-promotion'
import { readCodexSettingsBaseline } from './config-settings-baseline'
import { getCodexConfigSyncStatus, reportCodexConfigSyncOutcome } from './config-sync-stall'
import { preserveRuntimeConflictValues } from './codex-config-settings-preservation'
import { applyCodexDaemonSocketGuard } from './codex-daemon-socket-path-guard'
import { refuseUnreadableCodexConfigResult } from './codex-config-toml-checked-edit'
import { mergeSystemCodexConfigIntoRuntime } from './codex-config-mirror-merge'
import {
  prepareSystemConfigForFreshRuntimeMirror,
  prepareSystemConfigForRuntimeMirror,
  resolveCodexConfigMirrorSourceDirectory
} from './codex-config-mirror-source'

export { syncSystemConfigIntoLegacySharedCodexHome } from './codex-config-legacy-shared-home-mirror'
export {
  prepareSystemConfigForFreshRuntimeMirror,
  resolveCodexConfigMirrorSourceDirectory
} from './codex-config-mirror-source'

export function syncSystemConfigIntoManagedCodexHome(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): void {
  if (!mirrorSystemConfigIntoManagedCodexHome(homes)) {
    // Why: a stalled settings mirror must not also withhold the daemon guard,
    // or Codex cannot start at all in a long home.
    ensureCodexDaemonSocketGuard(homes.runtimeHomePath)
  }
}

/** Returns false when no mirror pass ran, so the caller still owes the daemon guard. */
function mirrorSystemConfigIntoManagedCodexHome(homes: CodexSettingsPromotionHomes): boolean {
  // Why: the mirror overwrites runtime settings from ~/.codex, so changes the
  // user made inside Orca-launched Codex (/model, /approvals) must be written
  // back to ~/.codex first or this very pass silently reverts them.
  const promotionPlan = promoteCodexRuntimeSettingsToSystem(homes)
  if (!promotionPlan) {
    // Why: mirroring after a failed write-back would erase the runtime change;
    // leave both runtime and its old baseline intact so the next launch retries.
    // Report first: once a baseline exists, an unreadable source throws inside
    // promotion rather than the mirror, so reporting only later would leave the
    // steady-state stall logging a reasonless failure on every pass forever.
    // Only a stall, never a clear: promotion failing on a readable source still
    // means no mirror ran, so clearing the latch here would claim a recovery
    // that did not happen and silence every later pass.
    const stalledStatus = getCodexConfigSyncStatus(homes)
    if (stalledStatus.state === 'stalled') {
      reportCodexConfigSyncOutcome(homes.runtimeHomePath, stalledStatus)
    }
    return false
  }
  let mirrorResult: CodexConfigMirrorResult
  try {
    mirrorResult = syncSystemConfigIntoManagedCodexHomeUnsafe(homes, promotionPlan)
  } catch (error) {
    // Why: an unreadable source throws out of the mirror, so reporting only on
    // the success path would leave that stall latch-less — logging the generic
    // failure on every launch and quota poll while the surfaced reason never
    // reaches the user.
    reportCodexConfigSyncOutcome(homes.runtimeHomePath, getCodexConfigSyncStatus(homes), error)
    return false
  }
  if (mirrorResult.status === 'refused-invalid') {
    // Why: writing a config Codex cannot parse breaks every managed-home launch;
    // keep the last good copy and advance nothing, like an unreadable source.
    return false
  }
  if (mirrorResult.status === 'refused-indeterminate') {
    // Why: no mirror ran, so this must behave exactly like the throwing path
    // above — surface the reason and advance nothing. Advancing the baseline
    // here would record an unmirrored runtime change as promoted and strand it.
    reportCodexConfigSyncOutcome(
      homes.runtimeHomePath,
      getCodexConfigSyncStatus(homes),
      mirrorResult.error
    )
    return false
  }
  // Why: report from the same pass that decided, so the surfaced status can
  // never disagree with what the mirror actually did.
  reportCodexConfigSyncOutcome(homes.runtimeHomePath, getCodexConfigSyncStatus(homes))
  if (mirrorResult.status === 'skipped-missing-source') {
    // Why: advancing an existing baseline would mark the unmirrored runtime
    // change as promoted, so it could never retry once the source reappears.
    // A runtime home seeded outside the mirror (WSL, per-account) has no
    // baseline at all, and promotion stays inert until one exists — bootstrap
    // it, since nothing is promotable yet and so nothing can be stranded.
    if (!readCodexSettingsBaseline(homes.runtimeHomePath)) {
      snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath)
    }
    return true
  }
  // Why: the baseline advances only after a successful mirror; recording an
  // unpromoted runtime change as Orca-written would strand it forever.
  snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath, {
    conflicts: new Map(
      [...promotionPlan.conflicts].filter(([key]) => mirrorResult.preservedConflictKeys.has(key))
    ),
    // Why: this pass made the runtime's marketplace and plugin tables canonical,
    // so a later source config that lacks one is a removal, not an addition.
    mirroredRegistrations: true,
    mirroredMcpServers: mirrorResult.mirroredMcpServerNames,
    mirroredMcpServerRoot: mirrorResult.mirroredMcpServerRoot
  })
  return true
}

/** Applies only the daemon guard, for passes that have no source config to mirror. */
export function ensureCodexDaemonSocketGuard(runtimeHomePath: string): void {
  try {
    const observation = observeAgentStateFile(join(runtimeHomePath, 'config.toml'))
    if (observation.kind !== 'indeterminate') {
      writeCodexDaemonSocketGuard(
        runtimeHomePath,
        observation.kind === 'present' ? observation.value : null
      )
    }
  } catch (error) {
    console.warn('[codex-config] Failed to apply the Codex daemon socket guard:', error)
  }
}

function writeCodexDaemonSocketGuard(runtimeHomePath: string, runtimeConfig: string | null): void {
  const guarded = applyCodexDaemonSocketGuard(runtimeConfig ?? '', runtimeHomePath)
  if (guarded !== (runtimeConfig ?? '')) {
    const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
    if (
      refuseUnreadableCodexConfigResult({
        configPath: runtimeConfigPath,
        result: guarded,
        inputs: [runtimeConfig],
        context: 'Skipped writing a managed Codex config'
      })
    ) {
      return
    }
    writeFileAtomicallyIfUnchanged(runtimeConfigPath, runtimeConfig, guarded)
  }
}

type CodexConfigMirrorResult =
  | { status: 'skipped-missing-source' }
  | { status: 'refused-indeterminate'; error: unknown }
  | { status: 'refused-invalid' }
  | {
      status: 'mirrored'
      preservedConflictKeys: ReadonlySet<string>
      mirroredMcpServerNames: ReadonlySet<string>
      mirroredMcpServerRoot: boolean
    }

function syncSystemConfigIntoManagedCodexHomeUnsafe(
  { runtimeHomePath, systemHomePath, systemConfigDir }: CodexSettingsPromotionHomes,
  promotionPlan: CodexSettingsPromotionPlan
): CodexConfigMirrorResult {
  const systemConfigPath = join(systemHomePath, 'config.toml')
  const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
  // Why: `existsSync` collapses an indeterminate probe into the same `false` as
  // absence, so a transiently unavailable RUNTIME config could reach the fresh
  // mirror after the path recovered. Neither side may be acted on unless it was
  // actually observed.
  const systemConfigObservation = observeAgentStateFile(systemConfigPath)
  if (systemConfigObservation.kind === 'indeterminate') {
    return { status: 'refused-indeterminate', error: systemConfigObservation.error }
  }
  const runtimeConfigObservation = observeAgentStateFile(runtimeConfigPath)
  if (runtimeConfigObservation.kind === 'indeterminate') {
    return { status: 'refused-indeterminate', error: runtimeConfigObservation.error }
  }
  const runtimeConfigExists = runtimeConfigObservation.kind === 'present'
  const rawSystemConfig =
    systemConfigObservation.kind === 'present' ? systemConfigObservation.value : ''
  // Why: a missing or blank source is not an authoritative empty config. Merging
  // it would erase every ordinary setting from an existing managed runtime, and
  // a 0-byte file is what a half-written or unhydrated cloud-synced home shows.
  if (rawSystemConfig.trim() === '') {
    // Why: no mirror write happens here, but the daemon guard must still land.
    writeCodexDaemonSocketGuard(
      runtimeHomePath,
      runtimeConfigExists ? runtimeConfigObservation.value : null
    )
    return runtimeConfigExists
      ? { status: 'skipped-missing-source' }
      : {
          status: 'mirrored',
          preservedConflictKeys: new Set(),
          mirroredMcpServerNames: new Set(),
          mirroredMcpServerRoot: false
        }
  }

  const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(systemHomePath, systemConfigDir)
  if (!runtimeConfigExists) {
    const freshRuntimeConfig = applyCodexDaemonSocketGuard(
      prepareSystemConfigForFreshRuntimeMirror(rawSystemConfig, sourceConfigDir),
      runtimeHomePath
    )
    if (refuseUnreadableMirrorResult(runtimeConfigPath, freshRuntimeConfig, [rawSystemConfig])) {
      return { status: 'refused-invalid' }
    }
    const ownership = readMcpServerTomlOwnership(freshRuntimeConfig)
    writeFileAtomically(runtimeConfigPath, freshRuntimeConfig)
    return {
      status: 'mirrored',
      preservedConflictKeys: new Set(),
      mirroredMcpServerNames: ownership.names,
      mirroredMcpServerRoot: ownership.ownsRoot
    }
  }

  const systemConfig = prepareSystemConfigForRuntimeMirror(rawSystemConfig, sourceConfigDir)
  const { names: mirroredMcpServerNames, ownsRoot: mirroredMcpServerRoot } =
    readMcpServerTomlOwnership(systemConfig)
  // Why: reuse the bytes already observed above rather than re-reading. A second
  // read could succeed where the first failed and re-open the gap this closes.
  const runtimeConfig = runtimeConfigObservation.value
  const preserved = preserveRuntimeConflictValues(
    mergeSystemCodexConfigIntoRuntime(
      runtimeConfig,
      systemConfig,
      sourceConfigDir,
      promotionPlan.mirroredMcpServers,
      promotionPlan.mirroredMcpServerRoot
    ),
    promotionPlan.runtimeValuesToPreserve
  )
  const nextRuntimeConfig = applyCodexDaemonSocketGuard(preserved.content, runtimeHomePath)
  if (nextRuntimeConfig !== runtimeConfig) {
    if (
      refuseUnreadableMirrorResult(runtimeConfigPath, nextRuntimeConfig, [
        rawSystemConfig,
        runtimeConfig
      ])
    ) {
      return { status: 'refused-invalid' }
    }
    writeFileAtomically(runtimeConfigPath, nextRuntimeConfig)
  }
  return {
    status: 'mirrored',
    preservedConflictKeys: preserved.keys,
    mirroredMcpServerNames,
    mirroredMcpServerRoot
  }
}

function refuseUnreadableMirrorResult(
  runtimeConfigPath: string,
  result: string,
  inputs: readonly (string | null)[]
): boolean {
  return refuseUnreadableCodexConfigResult({
    configPath: runtimeConfigPath,
    result,
    inputs,
    context: 'Skipped mirroring the Codex config into a managed home'
  })
}
