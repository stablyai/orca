import { release } from 'node:os'
import { resolvePtyOwnerBackend } from '../../shared/pty-owner-backend'
import { windowsPtyForOwnerBackend } from '../../shared/xterm-conpty-options'

/**
 * Reported in hello by a daemon whose live emulators resize like ConPTY (resizeLikeOwnPty), and
 * stamped into session meta for the log recorded against it. Daemons outlive app updates, so main
 * takes the model from the daemon hosting the session: one that reports none resizes as xterm.
 */
export const DAEMON_HISTORY_RESIZE_MODEL = 'conpty-viewport-v1'

/** This daemon's hello field. */
export function daemonHelloResizeModel(): { resizeModel?: string } {
  return { resizeModel: DAEMON_HISTORY_RESIZE_MODEL }
}

/**
 * The resize model to replay terminal history with: the live emulator's. Every session a Windows
 * daemon records is ConPTY, WSL shells included, so a replay of its saved output must move rows
 * through a resize as the live screen did, or the two disagree by the rows moved.
 */
export function historyReplayWindowsPty(
  resizeModel: string | null | undefined
): ReturnType<typeof windowsPtyForOwnerBackend> {
  return resizeModel === DAEMON_HISTORY_RESIZE_MODEL
    ? windowsPtyForOwnerBackend(
        resolvePtyOwnerBackend({ platform: process.platform, shellPath: undefined }),
        release()
      )
    : undefined
}
