import {
  isNativeWindowsLocalPtySpawn,
  markNativeWindowsConptyPty
} from '../../../runtime/terminal-model-query-authority'
import { registerPty } from '../../../memory/pty-registry'
import { createTerminalSessionStateSaveFailureMessage } from '../../../../shared/terminal-session-state-save-failure'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { StablePaneSpawnContext, StablePaneOwner } from './stable-owner'
import { persistAdmittedStablePaneBinding } from './stable-owner'
import { attemptStablePaneAttach } from './stable-pane-attach'
import { PaneOwnerContentionError } from './pane-spawn-operation'
import { admitPtySpawnOwnership, registerPersistedPtySpawn } from './spawn-registration'
import {
  assertSpawnReplyWasLive,
  seedTerminalRestoreRecordsFromSpawnResult
} from './agent-session-owners'
import { seedHeadlessTerminalFromSpawnResult } from './terminal-spawn-restore'
import { admitProviderReattachLaunchIdentity } from './launch-authority'
import { ensureWslHookRelayForReattach } from '../../../agent-hooks/wsl-hook-relay-reattach'
import { ptySizes } from '../delivery/visibility-state'
import {
  resolveCommittedPtySize,
  reflowHeadlessTerminalToCommittedGrid
} from '../delivery/attached-pty-size'
import { rememberPaneKeyForPty } from './key-state'
import {
  pendingByPaneKey,
  pendingPtyIdBySerializerGeneration,
  rendererSerializerReadiness
} from './serializer-state'

export async function completePaneAdoption(
  args: StablePaneSpawnContext & {
    owner: StablePaneOwner
    worktreeId: string
    preAllocatedHandle?: string
    renderer?: boolean
  }
) {
  const { runtime, owner } = args
  const paneKey = makePaneKey(owner.tabId, owner.leafId)
  const cachedBeforeAttach = ptySizes.get(owner.ptyId)
  const claim = runtime?.beginPtyRegistration?.(owner.ptyId, owner.runtimeIncarnationId)
  runtime?.preparePtyExecutionContext?.(owner.ptyId, null, {
    preserveExisting: true
  })
  const beforeAttach = runtime?.getPtyOutputSequence?.(owner.ptyId) ?? 0
  let incarnationId = owner.incarnationId
  try {
    const attempt = await attemptStablePaneAttach(args)
    if ('lostTo' in attempt) {
      throw new PaneOwnerContentionError()
    }
    if ('absent' in attempt) {
      return null
    }
    const result = attempt.attached.result
    if (args.spawnOptions.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    incarnationId = result.incarnationId
    const assertClaim = () => {
      if (claim && !runtime?.narrowPtyRegistration(result.id, claim, result.incarnationId)) {
        throw new PaneOwnerContentionError()
      }
    }
    assertClaim()
    assertSpawnReplyWasLive(result)
    runtime?.assertPtyRegistrationAllowed?.(result.id, result.incarnationId)
    const beforeReconcile = runtime?.getPtyOutputSequence?.(result.id) ?? 0
    const snapshotSeq = result.providerSequence
      ? runtime?.synchronizePtyOutputSequenceFromProvider?.(
          result.id,
          result.providerSequence,
          beforeAttach
        )
      : undefined
    ensureWslHookRelayForReattach(result, args.connectionId)
    runtime?.preparePtyExecutionContext?.(result.id, result.wslDistro ?? null, {
      preserveExisting: result.wslDistro === undefined
    })
    admitPtySpawnOwnership(runtime, result)
    if (
      !result.wslDistro &&
      isNativeWindowsLocalPtySpawn({
        connectionId: args.connectionId,
        cwd: args.spawnOptions.cwd,
        shellOverride: args.spawnOptions.shellOverride
      })
    ) {
      markNativeWindowsConptyPty(result.id)
    }
    seedHeadlessTerminalFromSpawnResult(runtime, result, paneKey)
    seedTerminalRestoreRecordsFromSpawnResult(runtime, result)
    try {
      await persistAdmittedStablePaneBinding({
        store: args.store,
        owner,
        result,
        worktreeId: args.worktreeId,
        startupCwd: args.spawnOptions.cwd,
        connectionId: args.connectionId
      })
    } catch (error) {
      if (
        error instanceof PaneOwnerContentionError ||
        (error instanceof Error && error.message === 'terminal_pane_owner_changed')
      ) {
        throw new PaneOwnerContentionError()
      }
      throw Object.assign(new Error(createTerminalSessionStateSaveFailureMessage(error)), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    }
    assertClaim()
    const terminalHandle = owner.handle ?? args.preAllocatedHandle
    const rejected = registerPersistedPtySpawn(
      runtime,
      args.store,
      claim,
      result.id,
      args.worktreeId,
      args.connectionId ?? null,
      {
        tabId: owner.tabId,
        leafId: owner.leafId,
        ...(terminalHandle ? { terminalHandle } : {}),
        ...(result.incarnationId ? { incarnationId: result.incarnationId } : {}),
        providerReattachLaunchIdentity: admitProviderReattachLaunchIdentity(result) ?? undefined
      }
    )
    if (rejected) {
      try {
        await rejected
      } catch (error) {
        if (
          !args.renderer ||
          !(error instanceof Error) ||
          error.message !== 'agent_session_exited_during_start'
        ) {
          throw error
        }
        return { result, owner, materialized: true as const }
      }
    }
    runtime?.noteTerminalSpawnCommit?.(result)
    if (!owner.handle && terminalHandle) {
      runtime?.registerPreAllocatedHandleForPty?.(result.id, terminalHandle)
    }
    const committedSize = resolveCommittedPtySize({
      result,
      requested: args.spawnOptions,
      cachedBeforeAttach
    })
    ptySizes.set(result.id, committedSize)
    reflowHeadlessTerminalToCommittedGrid({
      result,
      committedSize,
      reflowHeadlessTerminalToPtyGrid: runtime?.reflowHeadlessTerminalToPtyGrid?.bind(runtime)
    })
    seedTerminalRestoreRecordsFromSpawnResult(runtime, result)
    rememberPaneKeyForPty(result.id, paneKey)
    registerPty({
      ptyId: result.id,
      worktreeId: args.worktreeId,
      sessionId: result.id,
      paneKey,
      pid: result.pid ?? null
    })
    const pending = pendingByPaneKey.get(paneKey)
    rendererSerializerReadiness.beginIncarnation(
      result.id,
      !pending && rendererSerializerReadiness.has(result.id)
    )
    if (pending) {
      pendingPtyIdBySerializerGeneration.set(pending.gen, result.id)
    }
    return {
      result: {
        ...result,
        ...(typeof snapshotSeq === 'number' && beforeReconcile <= beforeAttach
          ? { snapshotSeq }
          : { snapshotKittyKeyboardFlags: undefined })
      },
      owner: { ...owner, ...(terminalHandle ? { handle: terminalHandle } : {}) },
      materialized: true as const
    }
  } finally {
    runtime?.cancelPendingPtyRegistration?.(owner.ptyId, incarnationId, claim)
  }
}
