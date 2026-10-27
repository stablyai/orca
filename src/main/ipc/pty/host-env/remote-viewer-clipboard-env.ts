import type { TuiAgent } from '../../../../shared/tui-agent'

/** Codex v0.162.1 emits OSC 52 under SSH/TMUX; a valid SSH_CONNECTION avoids tmux subprocess/passthrough and SSH_TTY device semantics. */
export const CODEX_REMOTE_VIEWER_SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 0'

/** Pi's own opt-in to emit OSC 52 alongside its host clipboard write; inert for every other program. */
export const PI_CLIPBOARD_OSC52_ENV = 'PI_CLIPBOARD_OSC52'

/** Route TUI clipboard writes to remote viewers via OSC 52 instead of only the host's clipboard (#23530, #33937). */
export function applyRemoteViewerClipboardEnv(
  env: Record<string, string>,
  options: {
    launchAgent: TuiAgent | undefined
    viewerIsRemote: boolean
    inheritedEnv?: NodeJS.ProcessEnv
  }
): void {
  if (!options.viewerIsRemote) {
    return
  }
  const inherited = options.inheritedEnv ?? process.env
  // Daemons merge their inherited environment after assembly; respect existing values there too.
  const isSet = (key: string): boolean => env[key] !== undefined || inherited[key] !== undefined
  // Why every shell: users start pi by hand, and the variable changes nothing else.
  if (!isSet(PI_CLIPBOARD_OSC52_ENV)) {
    env[PI_CLIPBOARD_OSC52_ENV] = '1'
  }
  // Why Codex only: a fake SSH session would change bare-shell prompts and tooling.
  if (options.launchAgent === 'codex' && !isSet('SSH_CONNECTION') && !isSet('SSH_TTY')) {
    env.SSH_CONNECTION = CODEX_REMOTE_VIEWER_SSH_CONNECTION
  }
}
