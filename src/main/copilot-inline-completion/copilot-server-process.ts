import { tmpdir } from 'node:os'
import { spawnProcess } from '../../shared/child-process/run-process'
import { signalProcessTree } from '../../shared/child-process/process-tree-termination'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'

export type CopilotServerProcess = ReturnType<typeof spawnProcess>

export const COPILOT_SERVER_COMMAND = 'copilot-language-server'

// Why: installing the server mid-session should not need a restart, but PATH
// probing on every editor open is wasteful; re-probe at most once a minute.
const PATH_PROBE_TTL_MS = 60_000

/** Nothing is bundled or downloaded: the server is used only when the user
 *  already installed `@github/copilot-language-server` onto PATH. */
export function createCopilotServerLocator(
  resolveOnPath: (command: string) => Promise<string | null> = resolveCommandOnLocalPath
): () => Promise<string | null> {
  let cached: { at: number; value: Promise<string | null> } | null = null
  return () => {
    if (!cached || Date.now() - cached.at > PATH_PROBE_TTL_MS) {
      cached = {
        at: Date.now(),
        value: resolveOnPath(COPILOT_SERVER_COMMAND).catch(() => null)
      }
    }
    return cached.value
  }
}

export function spawnCopilotServer(program: string): CopilotServerProcess {
  // Why: spawnProcess resolves npm .cmd shims and Windows quoting; it wants the
  // absolute program path, which the PATH probe already produced.
  const child = spawnProcess({
    program,
    args: ['--stdio'],
    cwd: tmpdir(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  // Why: nothing reads stderr; an undrained pipe blocks the server once the OS buffer fills.
  child.stderr.resume()
  return child
}

export function terminateCopilotServer(child: CopilotServerProcess): void {
  if (process.platform === 'win32') {
    // Why: an unresolved npm shim leaves cmd.exe as the root; kill its whole tree.
    void signalProcessTree(child)
    return
  }
  child.kill()
}
