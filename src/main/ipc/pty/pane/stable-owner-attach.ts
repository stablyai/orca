import { sameTerminalOwnerIdentity } from '../../../../shared/terminal-owner-identity'
import { TERMINAL_PANE_OWNER_UNVERIFIED } from '../../../../shared/terminal-pane-owner-verdict'
import {
  isDaemonEndpointGoneError,
  TerminalHostGoneError,
  TerminalSessionExitedError,
  TerminalSessionOwnerUnverifiedError
} from '../../../daemon/daemon-errors'
import type { PtySpawnResult } from '../../../providers/types'
import { isPtyAlreadyGoneError } from '../provider/liveness'
import { ptyOwnership } from '../provider/ownership-state'
import { clearProviderPtyState } from '../provider/state-cleanup'
import {
  retirePersistedStablePaneOwner,
  type StablePaneOwner,
  type StablePaneSpawnContext
} from './stable-owner'

export async function attachStablePaneOwner(
  args: StablePaneSpawnContext & { owner: StablePaneOwner }
): Promise<{ result: PtySpawnResult; owner: StablePaneOwner } | null> {
  const { owner, provider, runtime, spawnOptions } = args
  let result: PtySpawnResult
  try {
    if (
      owner.hasPersistedBinding &&
      owner.runtimeIncarnationId === undefined &&
      owner.persistedIncarnationId === undefined
    ) {
      throw new TerminalSessionOwnerUnverifiedError(owner.ptyId)
    }
    result = await provider.spawn({
      ...spawnOptions,
      sessionId: owner.ptyId,
      attachOnly: true,
      expectedIncarnationId: owner.runtimeIncarnationId ?? owner.persistedIncarnationId,
      expectedOwnerIdentity: owner.ownerIdentity,
      expectedIncarnationIsAuthoritative:
        owner.runtimeIncarnationId !== undefined || owner.hasPersistedBinding === true,
      isNewSession: undefined,
      command: undefined,
      commandDelivery: undefined,
      startupCommandDelivery: undefined,
      launchAgent: undefined,
      startupIngress: undefined,
      agentSessionEnsure: undefined,
      agentSessionCreateOperationId: undefined,
      onPtySpawnCommitted: undefined
    })
    if (
      owner.hasPersistedBinding &&
      owner.persistedIncarnationId !== undefined &&
      result.incarnationId !== owner.persistedIncarnationId
    ) {
      throw new TerminalSessionOwnerUnverifiedError(owner.ptyId)
    }
  } catch (error) {
    if (error instanceof TerminalSessionOwnerUnverifiedError) {
      throw new Error(TERMINAL_PANE_OWNER_UNVERIFIED)
    }
    if (isDaemonEndpointGoneError(error)) {
      throw new TerminalHostGoneError()
    }
    if (!(error instanceof TerminalSessionExitedError)) {
      if (isPtyAlreadyGoneError(error)) {
        throw new Error(TERMINAL_PANE_OWNER_UNVERIFIED)
      }
      throw error
    }
    const ownerBeforeRetire = args.resolveOwner?.()
    if (
      ownerBeforeRetire &&
      (ownerBeforeRetire.ptyId !== owner.ptyId ||
        ownerBeforeRetire.runtimeIncarnationId !== owner.runtimeIncarnationId ||
        ownerBeforeRetire.hasPersistedBinding !== owner.hasPersistedBinding ||
        ownerBeforeRetire.persistedIncarnationId !== owner.persistedIncarnationId)
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    if (
      args.worktreeId &&
      !retirePersistedStablePaneOwner(args.store, owner, args.worktreeId, args.connectionId)
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    runtime?.onPtyExit(owner.ptyId, 0, owner.incarnationId)
    clearProviderPtyState(owner.ptyId)
    ptyOwnership.delete(owner.ptyId)
    if (args.resolveOwner?.()) {
      throw new Error('terminal_pane_owner_changed')
    }
    return null
  }
  if (
    result.id !== owner.ptyId ||
    result.isReattach !== true ||
    (owner.runtimeIncarnationId !== undefined &&
      result.incarnationId !== owner.runtimeIncarnationId) ||
    (result.incarnationId === undefined && owner.incarnationId !== undefined) ||
    (owner.ownerIdentity !== undefined &&
      !sameTerminalOwnerIdentity(owner.ownerIdentity, result.ownerIdentity))
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
  return { result, owner }
}

export async function spawnForStablePane(
  args: StablePaneSpawnContext
): Promise<{ result: PtySpawnResult; owner: StablePaneOwner | null }> {
  if (args.owner) {
    const attached = await attachStablePaneOwner({ ...args, owner: args.owner })
    if (attached) {
      return attached
    }
  }
  const result = await args.provider.spawn(args.spawnOptions)
  args.onFreshSpawn?.(result)
  return { result, owner: null }
}
