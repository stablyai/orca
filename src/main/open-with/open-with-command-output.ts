import { runProcess } from '../../shared/child-process/run-process'

export const OPEN_WITH_COMMAND_TIMEOUT_MS = 10_000
const OPEN_WITH_COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** Runs a discovery command and resolves its stdout, rejecting on failure or timeout. */
export async function readOpenWithCommandOutput(
  command: string,
  args: string[],
  timeoutMs = OPEN_WITH_COMMAND_TIMEOUT_MS
): Promise<string> {
  const result = await runProcess({
    program: command,
    args,
    // Why: app discovery is a context-menu convenience; a stuck OS tool must
    // fall back to an empty list instead of keeping the menu IPC pending.
    timeoutMs,
    maxOutputBytes: OPEN_WITH_COMMAND_MAX_OUTPUT_BYTES,
    // Why: gio/xdg-mime localize their output and the parsers key on the
    // English text; force the C locale (inert for the other commands).
    env: { ...process.env, LC_ALL: 'C' }
  })
  if (result.timedOut) {
    throw new Error(`Timed out running ${command}`)
  }
  if (result.code !== 0) {
    throw new Error(
      `${command} exited with ${result.code ?? result.signal}: ${result.stderr.trim()}`
    )
  }
  return result.stdout
}
