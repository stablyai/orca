import { PtyStartupIngress } from '../../shared/terminal/pty/ingress/pty-startup-ingress'
import type { PtyStartupIngressOptions } from '../../shared/terminal/pty/ingress/pty-startup-ingress-contract'
import { getPtyOwnerColorsForWorktree } from '../../shared/terminal/pty/ingress/pty-owner-color-query-colors'
import { parsePtySessionId } from '../../shared/terminal/pty/lifecycle/pty-session-id-format'
import type { SessionOptions } from './sessions/session-options'

/** The session's OSC 10/11 owner; the minted-id fallback serves older clients that send no worktreeId. */
export function createSessionStartupIngress(
  opts: Pick<SessionOptions, 'sessionId' | 'startupIngress' | 'ownerBackend' | 'worktreeId'>,
  io: Pick<PtyStartupIngressOptions, 'write' | 'onEmission' | 'readForegroundGroup'>
): PtyStartupIngress {
  const worktreeId = opts.worktreeId || parsePtySessionId(opts.sessionId).worktreeId
  return new PtyStartupIngress({
    ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
    ...(opts.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
    resolveHostColors: () => getPtyOwnerColorsForWorktree(worktreeId),
    ...io
  })
}
