import { agentHookServer } from '../../agent-hooks/server'
import { clearMigrationUnsupportedPtysForPaneKey } from '../../agent-hooks/migration-unsupported-pty-state'
import { registerPty } from '../../memory/pty-registry'
import type { PtySpawnResult } from '../../providers/pty-provider-contract'
import {
  codexReattachedHomeRouteField,
  recordCodexPaneAccountForSpawn
} from './host-env/codex-home'
import { closeStartupQueryAuthorityForPty } from './provider/registry'
import { commitAttachedPtySize } from './delivery/attached-pty-size'
import { ptySizes } from './delivery/visibility-state'
import { rememberPaneKeyForPty } from './pane/key-state'
import {
  pendingByPaneKey,
  pendingPtyIdBySerializerGeneration,
  rendererSerializerReadiness
} from './pane/serializer-state'
import { seedTerminalRestoreRecordsFromSpawnResult } from './pane/agent-session-owners'
import { seedResumeLaunchIdentityFromSpawn } from './pane/resume-launch-identity'
import { recordPtySpawnTelemetry } from './pane/spawn-telemetry'
import { noteRuntimePaneCreateResult, resolvePaneSpawnReservation } from './pane/spawn-reservation'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { PtySpawnCommitInput, PtySpawnCommitState } from './spawn-commit-assembly'

/** Window migration inputs: legacy and reminted spawn keys alias the pane's proven key. */
export type PtySpawnPaneKeyAliases = {
  legacySpawnPaneKey: { paneKey: string } | null
  migrationUnsupportedPaneKey: string | null
  opaqueRemintedSpawnPaneKey: string | null
}

/** Everything a registered spawn publishes, in one order for both lanes; nothing here awaits. */
export function publishCommittedPtySpawn<Reply extends PtySpawnResult>(
  input: PtySpawnCommitInput<Reply>
): Reply {
  const { state } = input
  const { deps, args, result } = state
  const runtime = deps.runtime
  runtime?.noteTerminalSpawnCommit?.(result, input.expectedSourceBinding)
  input.spawnTiming?.log(result.id, {
    daemon: state.isDaemonHostSpawn,
    reattach: result.isReattach ?? false
  })
  recordCodexPaneAccountForSpawn({
    ptyId: result.id,
    isDaemonHostSpawn: state.isDaemonHostSpawn,
    isReattach: result.isReattach === true,
    pinnedByResume: state.codexResumeHomeSelected,
    launchCodexHomePath: state.selectedCodexHomePath,
    target: state.codexSelectionTarget,
    settings: deps.getSettings?.()
  })
  if (input.hiddenDelivery === 'renderer-scoped' && input.initiallyHidden) {
    markRendererScopedHiddenAtCommit(state)
  }
  if (input.preAllocatedHandle && !state.stablePaneOwner?.handle) {
    runtime?.registerPreAllocatedHandleForPty(result.id, input.preAllocatedHandle)
    if (state.agentTeamsLeaderHandle !== undefined) {
      // The registered handle now owns the Agent Teams leader this spawn prepared.
      state.agentTeamsLeaderHandle = null
    }
  }
  // Admission must precede reflow: a replaced spawn cannot resize its successor's model.
  commitAttachedPtySize({
    result,
    requested: { cols: args.cols, rows: args.rows },
    cachedBeforeAttach: state.sessionSizeBeforeAttach,
    reflowHeadlessTerminalToPtyGrid: runtime?.reflowHeadlessTerminalToPtyGrid?.bind(runtime)
  })
  if (state.effectiveSessionAppId !== undefined && state.effectiveSessionAppId !== result.id) {
    ptySizes.delete(state.effectiveSessionAppId)
  }
  beginSerializerIncarnation(result, input.paneKey)
  // Runtime list/read records remain main-owned even when renderer owns the emulator.
  seedTerminalRestoreRecordsFromSpawnResult(runtime, result)
  // Arm output detection from the launch command, matching renderer startup behavior.
  if (!state.stablePaneOwner) {
    runtime?.noteTerminalSpawnCommand?.(result.id, state.launchCommand ?? null)
  }
  // Emit agent_started only after confirmed spawn, with field validation at the telemetry boundary.
  if (args.telemetry && !state.stablePaneOwner) {
    recordPtySpawnTelemetry(args.telemetry)
  }
  // Publish reverse pane lookup for hook titles and provider cleanup.
  const rememberedPaneKey = rememberPaneKeyForPty(result.id, input.paneKey)
  if (input.paneKeyAliases) {
    registerSpawnPaneKeyAliases(result, input.paneKey, input.paneKeyAliases)
  }
  registerPty({
    ptyId: result.id,
    worktreeId: input.registration.worktreeId ?? null,
    sessionId: input.memorySessionId,
    paneKey: rememberedPaneKey,
    pid:
      typeof result.pid === 'number' && Number.isFinite(result.pid) && result.pid > 0
        ? result.pid
        : null
  })
  // Rejected spawns must not leave a published resume identity.
  seedResumeLaunchIdentityFromSpawn({
    paneKey: input.paneKey,
    launchAgent: args.launchAgent,
    resumeProviderSession: args.resumeProviderSession,
    connectionId: args.connectionId,
    worktreeId: args.worktreeId,
    launchedAt: state.codexHomeLaunchStartedAt,
    resumeArgvDropped: input.resumeArgvDropped,
    result
  })
  // Inventory cannot infer background/reattached PTYs from mounted views.
  deps.sendPtySpawnedToRenderer(result.id)
  deps.options?.onCodexHomePtySpawned?.({
    id: result.id,
    codexHomePath: state.selectedCodexHomePath,
    startedAt: state.codexHomeLaunchStartedAt,
    startedSequence: state.codexHomeLaunchStartedSequence,
    ...codexReattachedHomeRouteField(
      state.reattachedCodexHomeRoutes,
      result.id,
      result.isReattach === true
    ),
    ...(result.isReattach === true
      ? { reattached: true }
      : input.codexLaunchEnv
        ? { launchEnv: input.codexLaunchEnv }
        : {})
  })
  resolvePaneSpawnReservation(
    state.paneSpawnReservationKey,
    state.paneSpawnReservation,
    input.joinPayload.reservation
  )
  // A view waiting on this create attaches to the accepted result before its waiter resumes.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    noteRuntimePaneCreateResult(state.paneSpawnReservationKey, input.joinPayload.reservation)
  }
  return input.joinPayload.reply
}

function markRendererScopedHiddenAtCommit(state: PtySpawnCommitState): void {
  const { id } = state.result
  const transition = state.deps.transitionSpawnHiddenRendererPtyDeliveryState
  // Refresh the pre-spawn hidden mark only after this incarnation survives its save.
  transition?.(id, true)
  if (state.preSpawnHiddenMarkId !== null && state.preSpawnHiddenMarkId !== id) {
    // Defense: never strand a mark on an id the provider renamed.
    transition?.(state.preSpawnHiddenMarkId, false)
  }
  // Record ownership before routing background pacing for a hidden agent's first flood.
  state.deps.syncPtyBackgroundedDelivery?.(id, 'spawn')
  closeStartupQueryAuthorityForPty(id)
}

function beginSerializerIncarnation(result: PtySpawnResult, paneKey: string | null): void {
  const pendingSerializer = paneKey ? pendingByPaneKey.get(paneKey) : undefined
  const inheritRendererReadiness =
    result.isReattach === true && !pendingSerializer && rendererSerializerReadiness.has(result.id)
  rendererSerializerReadiness.beginIncarnation(result.id, inheritRendererReadiness)
  // Teardown must settle only this spawn's serializer generation, never a later remount.
  if (pendingSerializer) {
    pendingPtyIdBySerializerGeneration.set(pendingSerializer.gen, result.id)
  }
}

function registerSpawnPaneKeyAliases(
  result: PtySpawnResult,
  paneKey: string | null,
  aliases: PtySpawnPaneKeyAliases
): void {
  if (aliases.legacySpawnPaneKey && aliases.migrationUnsupportedPaneKey) {
    agentHookServer.registerPaneKeyAlias(
      aliases.legacySpawnPaneKey.paneKey,
      aliases.migrationUnsupportedPaneKey,
      result.id,
      Date.now(),
      { authorityVerified: true }
    )
    clearMigrationUnsupportedPtysForPaneKey(aliases.migrationUnsupportedPaneKey)
  } else if (aliases.opaqueRemintedSpawnPaneKey && paneKey) {
    // Reminted $$ tokens are spawn-physical; alias them to the metadata-proven tab:leaf key.
    agentHookServer.registerPaneKeyAlias(
      aliases.opaqueRemintedSpawnPaneKey,
      paneKey,
      result.id,
      Date.now(),
      { authorityVerified: true }
    )
  } else if (paneKey && !result.isReattach) {
    clearMigrationUnsupportedPtysForPaneKey(paneKey)
  }
}
