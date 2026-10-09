import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { PtyStartupIngressOptions } from '../../shared/pty-startup-ingress-contract'
import { getPtyOwnerColorsForWorktree } from '../../shared/pty-owner-color-query-colors'
import { parsePtySessionId } from '../../shared/pty-session-id-format'
import type { SessionOptions } from './session-options'

/** The session's OSC 10/11 owner; the minted-id fallback serves older clients that send no worktreeId. */
export function createSessionStartupIngress(
  opts: Pick<SessionOptions, 'sessionId' | 'startupIngress' | 'ownerBackend' | 'worktreeId'>,
  io: Pick<PtyStartupIngressOptions, 'write' | 'onEmission'>
): PtyStartupIngress {
  const worktreeId = opts.worktreeId || parsePtySessionId(opts.sessionId).worktreeId
  return new PtyStartupIngress({
    ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
    ...(opts.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
    resolveHostColors: () => getPtyOwnerColorsForWorktree(worktreeId),
    ...io
  })
}
