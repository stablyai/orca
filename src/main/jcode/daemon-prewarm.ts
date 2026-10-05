// Why: jcode's TUI client starts its own server and then waits a hardcoded 5s for
// the socket to answer a ping (`wait_for_server_ready` in
// crates/jcode-app-core/src/server/socket.rs). Orca gives every pane its own
// JCODE_RUNTIME_DIR, so every jcode pane is a COLD daemon start — and a cold start
// on a loaded machine overruns that budget, which is how an orchestration worker
// died with "Timed out waiting for responsive server socket" before its prompt was
// ever delivered. Starting the daemon as the PTY spawns gives it the shell's own
// startup time as head start, so the client finds a live socket instead of racing.
import { spawnProcess } from '../../shared/child-process/run-process'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'

export type JcodeDaemonPrewarm = {
  launchAgent?: string
  runtimeDir?: string
  cwd?: string
  env?: Record<string, string>
  platform?: NodeJS.Platform
}

/** Runtime dirs already warmed in this Orca process; the daemon outlives one pane. */
const warmed = new Set<string>()

export function resetJcodeDaemonPrewarmForTests(): void {
  warmed.clear()
}

/** The runtime dir to warm, or null when this pane is not a local jcode launch.
 *  Why non-Windows only: the runtime dir is a unix-socket directory, and Orca only
 *  stamps it off Windows (see shouldInjectJcodeRuntimeDir). */
function prewarmTarget({ launchAgent, runtimeDir, platform }: JcodeDaemonPrewarm): string | null {
  const unsupported = launchAgent !== 'jcode' || (platform ?? process.platform) === 'win32'
  return unsupported || !runtimeDir ? null : runtimeDir
}

/**
 * Start this pane's jcode daemon in the background, at most once per runtime dir.
 *
 * Fire-and-forget by contract: jcode's client starts its own server when none is
 * listening, so a pre-warm that fails costs nothing beyond the cold start Orca
 * already had. Never throws, and never blocks the spawn path.
 */
export function prewarmJcodeDaemon(args: JcodeDaemonPrewarm): boolean {
  const runtimeDir = prewarmTarget(args)
  if (runtimeDir === null || warmed.has(runtimeDir)) {
    return false
  }
  warmed.add(runtimeDir)
  // A missing binary or a spawn refusal just means no head start; forget the dir so
  // the next pane on it can try again.
  const giveUp = (): boolean => (warmed.delete(runtimeDir), false)
  try {
    const child = spawnProcess({
      program: getTuiAgentLaunchCommand(TUI_AGENT_CONFIG.jcode, args.platform ?? process.platform),
      // Why --no-update: an update check here would delay the very socket the client
      // is about to wait on. Why stdio ignore + unref: the daemon is jcode's to own
      // and must outlive this spawn, so Orca keeps no handle on it.
      args: ['--no-update', 'serve'],
      cwd: args.cwd,
      env: { ...args.env, JCODE_RUNTIME_DIR: runtimeDir },
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    child.on('error', giveUp)
    return true
  } catch {
    return giveUp()
  }
}
