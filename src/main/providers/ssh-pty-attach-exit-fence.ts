import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SSH_SESSION_EXPIRED_ERROR } from './ssh-pty-errors'
import { parseSshPtyAttachResult, type SshPtyAttachResult } from './ssh-pty-session-reattach'
import type { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'

export type SshPtyAttachContext = {
  mux: SshChannelMultiplexer
  exitRaceTracker: SshPtySpawnExitRaceTracker
  livePtyIds: Set<string>
  toRelayPtyId: (id: string) => string
  toAppPtyId: (id: string) => string
}

/**
 * Runs a `pty.attach` request and reports whether a matching `pty.exit` beat it home.
 *
 * Why: the relay can deliver the exit inside the attach reply batch, and its handler
 * removes the id from `livePtyIds` during the await. Marking the PTY live after that
 * would resurrect one the relay already reported dead — the phantom-live state the
 * dead-PTY write guard exists to prevent (#9169) — so the exit wins the race.
 */
async function fenceAttach(
  ctx: SshPtyAttachContext,
  id: string,
  params: Record<string, unknown>
): Promise<{ result: SshPtyAttachResult; exited: boolean }> {
  const operation = ctx.exitRaceTracker.begin()
  try {
    const result = parseSshPtyAttachResult(await ctx.mux.request('pty.attach', params))
    // Why: an absent incarnation on either side matches any exit for this relay id —
    // the conservative direction, mirroring the spawn fence.
    const exited = ctx.exitRaceTracker.didMatchingExitArrive(operation, {
      id: ctx.toRelayPtyId(id),
      ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
    })
    if (!exited) {
      ctx.livePtyIds.add(ctx.toAppPtyId(id))
    }
    return { result, exited }
  } finally {
    ctx.exitRaceTracker.finish(operation)
  }
}

/**
 * Why: a resolved attach is the relay asserting it owns this PTY; without marking it
 * live a quiet PTY stays absent from `livePtyIds` until its first frame arrives.
 */
export async function attachSshPty(ctx: SshPtyAttachContext, id: string): Promise<void> {
  const relayPtyId = ctx.toRelayPtyId(id)
  const { exited } = await fenceAttach(ctx, id, { id: relayPtyId })
  if (exited) {
    // Why: this path has no outer fence, so a caller that ignores hasPty would keep
    // writing into a gone PTY; fail the attach rather than resolve on a dead lease.
    throw new Error(`${SSH_SESSION_EXPIRED_ERROR}: ${relayPtyId}`)
  }
}

/**
 * Why: reconnect owns replay delivery so stale/duplicate attach results can be filtered
 * before they reach the renderer, and the expected identity lets the relay reject a
 * cross-generation id collision instead of reattaching this lease to a different pane's
 * freshly spawned PTY.
 *
 * Why: this returns the result even when the PTY exited mid-attach — ssh-relay-session's
 * pending-exit fence needs the incarnation to retire the pane, and throwing here would
 * abandon every later PTY in its reattach loop. The fence still withholds liveness.
 */
export async function attachSshPtyForReconnect(
  ctx: SshPtyAttachContext,
  id: string,
  expected?: { paneKey?: string; tabId?: string }
): Promise<SshPtyAttachResult> {
  const { result } = await fenceAttach(ctx, id, {
    id: ctx.toRelayPtyId(id),
    suppressReplayNotification: true,
    ...(expected?.paneKey ? { expectedPaneKey: expected.paneKey } : {}),
    ...(expected?.tabId ? { expectedTabId: expected.tabId } : {})
  })
  return result
}
