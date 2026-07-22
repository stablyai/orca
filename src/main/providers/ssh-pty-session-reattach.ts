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

export type SshPtyAttachResult = {
  replay?: string
  incarnationId?: PtyIncarnationId
}

export function parseSshPtyAttachResult(value: unknown): SshPtyAttachResult {
  if (value === undefined || value === null) {
    return {}
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid SSH PTY attach response')
  }
  const result = value as { replay?: unknown; incarnationId?: unknown }
  if (result.replay !== undefined && typeof result.replay !== 'string') {
    throw new Error('Invalid SSH PTY attach replay')
  }
  if (result.incarnationId !== undefined && !isPtyIncarnationId(result.incarnationId)) {
    // Why: a present-but-invalid identity cannot safely fence delayed exits from a reused relay id.
    throw new Error('Invalid SSH PTY attach incarnation')
  }
  return {
    ...(typeof result.replay === 'string' ? { replay: result.replay } : {}),
    ...(isPtyIncarnationId(result.incarnationId) ? { incarnationId: result.incarnationId } : {})
  }
}

export async function reattachSshPtySession(args: {
  mux: SshChannelMultiplexer
  connectionId: string
  sessionId: string
  options: PtySpawnOptions
}): Promise<PtySpawnResult> {
  const relaySessionId = toRelaySshPtyId(args.connectionId, args.sessionId)
  console.warn(`[ssh-pty] spawn() called with sessionId=${args.sessionId}, attempting pty.attach`)
  try {
    // Why: expected pane identity prevents a reused relay id from attaching the wrong shell.
    const expectedPaneKey = args.options.paneKey ?? args.options.env?.ORCA_PANE_KEY
    const expectedTabId = args.options.tabId ?? args.options.env?.ORCA_TAB_ID
    const attachResult = parseSshPtyAttachResult(
      await args.mux.request('pty.attach', {
        id: relaySessionId,
        cols: args.options.cols,
        rows: args.options.rows,
        suppressReplayNotification: true,
        ...(expectedPaneKey ? { expectedPaneKey } : {}),
        ...(expectedTabId ? { expectedTabId } : {})
      })
    )
    console.warn(
      `[ssh-pty] pty.attach succeeded for ${args.sessionId}, replay=${!!attachResult.replay}`
    )
    return {
      id: toAppSshPtyId(args.connectionId, relaySessionId),
      isReattach: true,
      ...(attachResult.replay ? { replay: attachResult.replay } : {}),
      ...(attachResult.incarnationId ? { incarnationId: attachResult.incarnationId } : {})
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
): Promise<PtySpawnResult> {
  const operation = args.exitRaceTracker.begin()
  try {
    const result = await reattachSshPtySession(args)
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
  } finally {
    args.exitRaceTracker.finish(operation)
  }
}
