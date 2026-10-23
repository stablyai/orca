import type { TuiAgent } from '../../../../shared/tui-agent'

/**
 * Codex (rust-v0.162.1 `clipboard_copy.rs`) copies to the clipboard of the machine it
 * runs on and sends OSC 52 to the terminal only when SSH_TTY, SSH_CONNECTION or TMUX
 * is set. SSH_CONNECTION is the least side-effectful trigger: TMUX makes Codex shell
 * out to tmux and wrap OSC 52 in tmux passthrough, and SSH_TTY names a tty device.
 * Syntactically valid (client ip/port, server ip/port) for tools that parse it.
 */
export const CODEX_REMOTE_VIEWER_SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 0'

/**
 * Makes an Orca-launched Codex copy through the viewer's terminal (OSC 52) when the
 * viewer is on another machine, so selection copy and Ctrl+C reach the user's clipboard.
 * Scoped to Codex launches: bare shells keep their real SSH posture. (#23530)
 */
export function applyCodexRemoteViewerClipboardEnv(
  env: Record<string, string>,
  options: {
    launchAgent: TuiAgent | undefined
    viewerIsRemote: boolean
    inheritedEnv?: NodeJS.ProcessEnv
  }
): void {
  if (options.launchAgent !== 'codex' || !options.viewerIsRemote) {
    return
  }
  const inherited = options.inheritedEnv ?? process.env
  // Why process.env too: daemon spawns merge the host's inherited env after this build.
  const alreadySsh = ['SSH_CONNECTION', 'SSH_TTY'].some(
    (key) => env[key] !== undefined || inherited[key] !== undefined
  )
  if (!alreadySsh) {
    env.SSH_CONNECTION = CODEX_REMOTE_VIEWER_SSH_CONNECTION
  }
}
