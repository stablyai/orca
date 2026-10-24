import type { TuiAgent } from '../../../../shared/tui-agent'

/** Codex v0.162.1 emits OSC 52 under SSH/TMUX; a valid SSH_CONNECTION avoids tmux subprocess/passthrough and SSH_TTY device semantics. */
export const CODEX_REMOTE_VIEWER_SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 0'

/** Route Orca-launched Codex clipboard writes to remote viewers via OSC 52; preserve bare-shell SSH state (#23530). */
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
  // Daemons merge their inherited environment after assembly; respect existing SSH state there too.
  const alreadySsh = ['SSH_CONNECTION', 'SSH_TTY'].some(
    (key) => env[key] !== undefined || inherited[key] !== undefined
  )
  if (!alreadySsh) {
    env.SSH_CONNECTION = CODEX_REMOTE_VIEWER_SSH_CONNECTION
  }
}
