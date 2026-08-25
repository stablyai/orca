import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isPtyIncarnationId, type PtyIncarnationId } from '../../shared/pty-incarnation'
import {
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  SSH_SESSION_EXPIRED_ERROR,
  isSshPtyIdentityMismatchError,
  isSshPtyNotFoundError
} from './ssh-pty-errors'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import type { PtySpawnOptions, PtySpawnResult } from './types'
import type { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'
import type {
  PtySourceRecoveryRequest,
  PtySourceRecoveryResult
} from '../../shared/pty-source-recovery-contract'
import {
  parsePtySourceReceivingActivation,
  type PtySourceReceivingActivation
} from '../../shared/pty-source-receiving-activation'
import type { SshPtyReceivingActivationLease } from './ssh-pty-notification-routing'

export type SshPtyAttachResult = {
  replay?: string
  incarnationId?: PtyIncarnationId
  sourceRecovery?: PtySourceRecoveryResult
  sourceActivation?: PtySourceReceivingActivation
  sourceActivationLease?: SshPtyReceivingActivationLease
}

type SshPtyReattachResult = PtySpawnResult & {
  sourceRecovery?: PtySourceRecoveryResult
  sourceActivationLease?: SshPtyReceivingActivationLease
}

export function parseSshPtyAttachResult(value: unknown): SshPtyAttachResult {
  if (value === undefined || value === null) {
    return {}
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid SSH PTY attach response')
  }
  const result = value as {
    replay?: unknown
    incarnationId?: unknown
    sourceRecovery?: unknown
    sourceActivation?: unknown
  }
  if (result.replay !== undefined && typeof result.replay !== 'string') {
    throw new Error('Invalid SSH PTY attach replay')
  }
  if (result.incarnationId !== undefined && !isPtyIncarnationId(result.incarnationId)) {
    // Why: a present-but-invalid identity cannot safely fence delayed exits from a reused relay id.
    throw new Error('Invalid SSH PTY attach incarnation')
  }
  const sourceRecovery = parseSourceRecoveryResult(result.sourceRecovery)
  const sourceActivation = parsePtySourceReceivingActivation(result.sourceActivation)
  const activation =
    sourceActivation ?? (sourceRecovery?.status === 'pending' ? sourceRecovery : undefined)
  if (
    activation &&
    (!isPtyIncarnationId(result.incarnationId) ||
      activation.ptyIncarnation !== result.incarnationId ||
      (sourceRecovery?.status === 'pending' && !sameSourceActivation(activation, sourceRecovery)))
  ) {
    throw new Error('Invalid SSH PTY source activation identity')
  }
  return {
    ...(typeof result.replay === 'string' ? { replay: result.replay } : {}),
    ...(isPtyIncarnationId(result.incarnationId) ? { incarnationId: result.incarnationId } : {}),
    ...(sourceRecovery ? { sourceRecovery } : {}),
    ...(activation ? { sourceActivation: activation } : {})
  }
}

export async function requestSshPtyAttach(args: {
  mux: SshChannelMultiplexer
  relayPtyId: string
  params: Record<string, unknown>
  timeoutMs?: number
  commitSourceActivation?: boolean
  installSourceActivation?: (
    relayPtyId: string,
    activation: PtySourceReceivingActivation
  ) => SshPtyReceivingActivationLease
  rememberPtyIncarnation?: (relayPtyId: string, incarnationId: unknown) => void
}): Promise<SshPtyAttachResult> {
  let activationLease: SshPtyReceivingActivationLease | undefined
  const installFromResult = (result: SshPtyAttachResult): void => {
    if (!activationLease && result.sourceActivation && args.installSourceActivation) {
      activationLease = args.installSourceActivation(args.relayPtyId, result.sourceActivation)
    }
  }
  try {
    const rawResult = await args.mux.request('pty.attach', args.params, {
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      beforeResolve: (value) => installFromResult(parseSshPtyAttachResult(value))
    })
    const result = parseSshPtyAttachResult(rawResult)
    installFromResult(result)
    args.rememberPtyIncarnation?.(args.relayPtyId, result.incarnationId)
    if (args.commitSourceActivation) {
      activationLease?.commit()
    }
    return {
      ...result,
      ...(activationLease ? { sourceActivationLease: activationLease } : {})
    }
  } catch (error) {
    activationLease?.rollback()
    throw error
  }
}

function parseSourceRecoveryResult(value: unknown): PtySourceRecoveryResult | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid SSH PTY source recovery response')
  }
  const input = value as Record<string, unknown>
  if (input.status === 'restoreRequired' && typeof input.reason === 'string') {
    return Object.freeze({ status: 'restoreRequired', reason: input.reason })
  }
  if (
    input.status !== 'pending' ||
    typeof input.deliveryToken !== 'string' ||
    input.deliveryToken.length === 0 ||
    typeof input.ptyIncarnation !== 'string' ||
    input.ptyIncarnation.length === 0 ||
    !positiveInteger(input.clientGeneration) ||
    !positiveInteger(input.ownerGeneration) ||
    !nonNegativeInteger(input.checkpointSourceEndSu) ||
    !nonNegativeInteger(input.recoveryEndSu) ||
    Number(input.recoveryEndSu) < Number(input.checkpointSourceEndSu)
  ) {
    throw new Error('Invalid SSH PTY source recovery response')
  }
  return Object.freeze({
    status: 'pending',
    deliveryToken: input.deliveryToken,
    ptyIncarnation: input.ptyIncarnation,
    clientGeneration: Number(input.clientGeneration),
    ownerGeneration: Number(input.ownerGeneration),
    checkpointSourceEndSu: Number(input.checkpointSourceEndSu),
    recoveryEndSu: Number(input.recoveryEndSu)
  })
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function sameSourceActivation(
  left: PtySourceReceivingActivation,
  right: PtySourceReceivingActivation
): boolean {
  return (
    left.clientGeneration === right.clientGeneration &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ptyIncarnation === right.ptyIncarnation &&
    left.deliveryToken === right.deliveryToken &&
    left.checkpointSourceEndSu === right.checkpointSourceEndSu &&
    left.recoveryEndSu === right.recoveryEndSu
  )
}

export type { PtySourceRecoveryRequest }

export async function reattachSshPtySession(args: {
  mux: SshChannelMultiplexer
  connectionId: string
  sessionId: string
  options: PtySpawnOptions
  rememberPtyIncarnation?: (relayPtyId: string, incarnationId: unknown) => void
  installSourceActivation?: (
    relayPtyId: string,
    activation: PtySourceReceivingActivation
  ) => SshPtyReceivingActivationLease
}): Promise<SshPtyReattachResult> {
  const relaySessionId = toRelaySshPtyId(args.connectionId, args.sessionId)
  console.warn(`[ssh-pty] spawn() called with sessionId=${args.sessionId}, attempting pty.attach`)
  try {
    // Why: expected pane identity prevents a reused relay id from attaching the wrong shell.
    const expectedPaneKey = args.options.paneKey ?? args.options.env?.ORCA_PANE_KEY
    const expectedTabId = args.options.tabId ?? args.options.env?.ORCA_TAB_ID
    const attachResult = await requestSshPtyAttach({
      mux: args.mux,
      relayPtyId: relaySessionId,
      params: {
        id: relaySessionId,
        cols: args.options.cols,
        rows: args.options.rows,
        suppressReplayNotification: true,
        // A reattach always paints into a NEW terminal: a reconnect bumps tab.generation, which is
        // the pane's React key, so TerminalPane remounts and the old xterm is disposed with its
        // buffer. Without this the relay sees a delivery still open under our unchanged client id,
        // answers "you already have this", and the pane stays blank until new output arrives.
        requireReplay: true,
        ...(expectedPaneKey ? { expectedPaneKey } : {}),
        ...(expectedTabId ? { expectedTabId } : {})
      },
      installSourceActivation: args.installSourceActivation,
      rememberPtyIncarnation: args.rememberPtyIncarnation
    })
    console.warn(
      `[ssh-pty] pty.attach succeeded for ${args.sessionId}, replay=${!!attachResult.replay}`
    )
    return {
      id: toAppSshPtyId(args.connectionId, relaySessionId),
      isReattach: true,
      ...(attachResult.replay ? { replay: attachResult.replay } : {}),
      ...(attachResult.incarnationId ? { incarnationId: attachResult.incarnationId } : {}),
      ...(attachResult.sourceRecovery ? { sourceRecovery: attachResult.sourceRecovery } : {}),
      ...(attachResult.sourceActivation ? { sourceActivation: attachResult.sourceActivation } : {}),
      ...(attachResult.sourceActivationLease
        ? { sourceActivationLease: attachResult.sourceActivationLease }
        : {})
    }
  } catch (error) {
    // Why: an expired relay lease must be surfaced distinctly so the renderer clears its binding.
    console.warn(`[ssh-pty] pty.attach FAILED for ${args.sessionId}:`, error)
    if (isSshPtyNotFoundError(error)) {
      const mismatchMarker = isSshPtyIdentityMismatchError(error)
        ? ` ${SSH_PTY_IDENTITY_MISMATCH_ERROR}`
        : ''
      throw new Error(`${SSH_SESSION_EXPIRED_ERROR}: ${relaySessionId}${mismatchMarker}`)
    }
    throw error
  }
}

export async function reattachSshPtySessionWithExitFence(
  args: Parameters<typeof reattachSshPtySession>[0] & {
    exitRaceTracker: SshPtySpawnExitRaceTracker
  }
): Promise<SshPtyReattachResult> {
  const operation = args.exitRaceTracker.begin()
  let result: SshPtyReattachResult | undefined
  try {
    result = await reattachSshPtySession(args)
    const relayPtyId = toRelaySshPtyId(args.connectionId, result.id)
    if (
      args.exitRaceTracker.didMatchingExitArrive(operation, {
        id: relayPtyId,
        incarnationId: result.incarnationId
      })
    ) {
      throw new Error('agent_session_exited_during_start')
    }
    return result
  } catch (error) {
    result?.sourceActivationLease?.rollback()
    throw error
  } finally {
    args.exitRaceTracker.finish(operation)
  }
}

/**
 * The full reattach path a spawn takes when it carries a sessionId: fence the
 * exit race, reject a session the relay can no longer restore, and commit or
 * roll back the source-activation lease.
 *
 * Lives here rather than in SshPtyProvider.spawn so the lease's commit and
 * rollback stay in one place — a caller that only wrapped the fence could
 * return without committing and silently leak the activation.
 */
export async function reattachSshPtySessionForSpawn(
  args: Parameters<typeof reattachSshPtySessionWithExitFence>[0] & {
    acceptLivePty: (relayPtyId: string) => void
  }
): Promise<PtySpawnResult> {
  let result: SshPtyReattachResult | undefined
  try {
    result = await reattachSshPtySessionWithExitFence(args)
    if (result.sourceRecovery?.status === 'restoreRequired') {
      throw new Error(
        `${SSH_SESSION_EXPIRED_ERROR}: ${toRelaySshPtyId(args.connectionId, result.id)}`
      )
    }
    args.acceptLivePty(result.id)
    result.sourceActivationLease?.commit()
    const {
      sourceActivationLease: _lease,
      sourceRecovery: _sourceRecovery,
      ...spawnResult
    } = result
    return spawnResult
  } catch (error) {
    result?.sourceActivationLease?.rollback()
    throw error
  }
}
