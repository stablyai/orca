import { execFile } from 'node:child_process'

export const OPEN_WITH_COMMAND_TIMEOUT_MS = 10_000
const OPEN_WITH_COMMAND_MAX_BUFFER = 4 * 1024 * 1024

/** Runs a discovery command and resolves its stdout, rejecting on failure or timeout. */
export function readOpenWithCommandOutput(
  command: string,
  args: string[],
  timeoutMs = OPEN_WITH_COMMAND_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const child = execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: OPEN_WITH_COMMAND_MAX_BUFFER,
        windowsHide: true,
        // Why: gio/xdg-mime localize their output and the parsers key on the
        // English text; force the C locale (inert for the other commands).
        env: { ...process.env, LC_ALL: 'C' }
      },
      (error, stdout) => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
        }
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
    timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      // Why: app discovery is a context-menu convenience; a stuck OS tool must
      // fall back to an empty list instead of keeping the menu IPC pending.
      child.kill()
      reject(new Error(`Timed out running ${command}`))
    }, timeoutMs)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
  })
}
