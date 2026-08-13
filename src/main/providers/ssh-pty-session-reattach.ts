import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  isPtyIncarnationId,
  isRelayAttestedPtyIncarnationId,
  type PtyIncarnationId
} from '../../shared/pty-incarnation'
import {
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  SSH_SESSION_EXPIRED_ERROR,
  isSshPtyExitedError,
  isSshPtyIdentityMismatchError
} from './ssh-pty-errors'
import { parseMatchingPtyExitedError } from '../../shared/ssh-pty-failure-tokens'
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

export function buildSshPtyReconnectAttachParams(args: {
  id: string
  sourceRecovery?: PtySourceRecoveryRequest
  expectedIncarnationId?: string
  legacyExpectedIdentity?: { paneKey?: string; tabId?: string }
}): Record<string, unknown> {
  return {
    id: args.id,
    suppressReplayNotification: true,
    exitProofSupported: true,
    ...(isRelayAttestedPtyIncarnationId(args.expectedIncarnationId)
      ? { expectedIncarnationId: args.expectedIncarnationId }
      : {}),
    ...(args.legacyExpectedIdentity?.paneKey
      ? { expectedPaneKey: args.legacyExpectedIdentity.paneKey }
      : {}),
    ...(args.legacyExpectedIdentity?.tabId
      ? { expectedTabId: args.legacyExpectedIdentity.tabId }
      : {}),
    ...(args.sourceRecovery ? { sourceRecovery: args.sourceRecovery } : {})
  }
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
  const parseResult = (value: unknown): SshPtyAttachResult => {
    const result = parseSshPtyAttachResult(value)
    const expectedIncarnationId = args.params.expectedIncarnationId
    // Old relays ignore the request fence, so their response must prove the same shell.
    if (
      isRelayAttestedPtyIncarnationId(expectedIncarnationId) &&
      result.incarnationId !== expectedIncarnationId
    ) {
      throw new Error(`${SSH_PTY_IDENTITY_MISMATCH_ERROR}: ${args.relayPtyId}`)
    }
    return result
  }
  const installFromResult = (result: SshPtyAttachResult): void => {
    if (!activationLease && result.sourceActivation && args.installSourceActivation) {
      activationLease = args.installSourceActivation(args.relayPtyId, result.sourceActivation)
    }
  }
  try {
    const rawResult = await args.mux.request('pty.attach', args.params, {
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
      beforeResolve: (value) => installFromResult(parseResult(value))
    })
    const result = parseResult(rawResult)
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
        // Declares that this client can act on a proven exit. Without it a host must keep answering
        // in the older wording, because an older client reads anything else as an unknown failure
        // and leaves the pane with no shell and no way back.
        exitProofSupported: true,
        // The shell's own identity, so it survives a pane moving between tabs — unlike the pane
        // identity this replaced. Sent only when the host attested it: a locally synthesized
        // stand-in is not stable across reconnects and would refuse the pane its own shell. An
        // older relay ignores the field, so the legacy pane fence below remains its fallback.
        ...(isRelayAttestedPtyIncarnationId(args.options.expectedIncarnationId)
          ? { expectedIncarnationId: args.options.expectedIncarnationId }
          : {}),
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
    // Why: the relay reports a mismatch by saying "not found", but it found the
    // pty — comparing identity is how it knows. Publishing expiry there makes
    // the renderer respawn and resume the agent a second time onto a live shell.
    if (isSshPtyIdentityMismatchError(error)) {
      throw new Error(`${SSH_PTY_IDENTITY_MISMATCH_ERROR}: ${relaySessionId}`)
    }
    // The relay WATCHED this shell exit, which is the only answer that proves it is gone, so this
    // is the one route that may authorize a replacement. The proof still has to be about OUR shell:
    // the host applies that rule too, but the host is the party whose answer is in question and
    // versions differ, so a proof we cannot tie to the incarnation we asked about is not proof and
    // falls through to the disconnected pane instead of replacing a shell that may be running.
    if (isSshPtyExitedError(error)) {
      const proof = parseMatchingPtyExitedError(
        error instanceof Error ? error.message : String(error),
        relaySessionId,
        args.options.expectedIncarnationId
      )
      if (proof) {
        throw new Error(`${SSH_SESSION_EXPIRED_ERROR}: ${relaySessionId}`)
      }
      throw error
    }
    // A bare not-found deliberately does NOT become expiry any more. It means the relay we asked
    // cannot hand the id back, which is proof of an exit only if that relay is the one that minted
    // it — and a replaced relay answers exactly this for shells still running under its
    // predecessor. Treating it as death cleared ownership and resumed the agent a second time onto
    // a live shell. Unproven now falls through to the caller, which shows the pane as
    // disconnected and lets the user decide.
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
