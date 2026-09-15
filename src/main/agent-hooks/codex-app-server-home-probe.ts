/**
 * Ask the host's own `codex` where its `CODEX_HOME` is.
 *
 * A launcher wrapper earlier on `PATH` can `export CODEX_HOME=...` and `exec`
 * the real binary, so the value exists only inside the Codex process: the
 * parent PTY's login shell reports nothing, and Orca installed its managed
 * hooks into `~/.codex` while Codex read `~/.codex-openai` (#19598). The
 * app-server `initialize` handshake is the wrapper-aware answer, because it
 * comes from the same process the wrapper configured.
 *
 * The probe therefore runs through a login shell — that is what resolves the
 * wrapper in the first place — and reads stdout a line at a time, so a profile
 * banner printed ahead of the JSON cannot corrupt the reply.
 */

import { spawnProcess } from '../../shared/child-process/run-process'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'

const PROBE_TIMEOUT_MS = 12_000
const MAX_STDOUT_BYTES = 64 * 1024
const INITIALIZE_ID = 1

/**
 * The environment the probe hands the child.
 *
 * `HOME` is pinned to the home the installer resolved, so parent and child
 * agree on which account is being configured. `CODEX_HOME`/`ORCA_CODEX_HOME`
 * are dropped because Orca injects them for its own managed accounts — reading
 * one back would report Orca's own answer as if it were the host user's. A
 * value the user's profile or launcher wrapper sets is unaffected: the login
 * shell re-exports it, which is the whole point of the probe.
 */
export function buildCodexProbeEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
  delete env.CODEX_HOME
  delete env.ORCA_CODEX_HOME
  return env
}

/**
 * `codex app-server` exits without answering when stdin reaches EOF, so the
 * request is written and the pipe is left open until the reply lands.
 */
function initializeRequest(): string {
  return `${JSON.stringify({
    id: INITIALIZE_ID,
    method: 'initialize',
    params: { clientInfo: { name: 'orca', title: 'Orca', version: '1.0.0' } }
  })}\n`
}

function readCodexHomeFromLine(line: string): string | null {
  if (!line.startsWith('{')) {
    return null
  }
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    return null
  }
  const envelope = message as { id?: unknown; result?: { codexHome?: unknown } }
  if (envelope.id !== INITIALIZE_ID || typeof envelope.result?.codexHome !== 'string') {
    return null
  }
  return envelope.result.codexHome
}

/**
 * The raw `codexHome` the host's Codex reports, or `null` when it does not
 * answer. Callers validate the shape; this only refuses to invent one.
 */
export function probeCodexHomeViaAppServer(options: {
  loginShell: string
  loginShellFlag: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<string | null> {
  const command = `exec codex ${CODEX_READ_ONLY_APP_SERVER_ARGS.join(' ')}`
  return new Promise<string | null>((resolve) => {
    let child: ReturnType<typeof spawnProcess>
    try {
      child = spawnProcess({
        program: options.loginShell,
        args: [options.loginShellFlag, command],
        stdio: ['pipe', 'pipe', 'ignore'],
        ...(options.env ? { env: options.env } : {})
      })
    } catch {
      resolve(null)
      return
    }

    let pending = ''
    let bytesRead = 0
    let settled = false
    const timer = setTimeout(() => settle(null), options.timeoutMs ?? PROBE_TIMEOUT_MS)

    function settle(codexHome: string | null): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout.off('data', onData)
      child.off('error', onFailure)
      child.off('close', onClose)
      child.stdin.off('error', onFailure)
      // Why: the handshake is all we wanted; a long-lived app-server here would
      // outlive the install and hold the user's Codex state files open.
      child.kill()
      resolve(codexHome)
    }

    function onAbort(): void {
      settle(null)
    }

    function onFailure(): void {
      settle(null)
    }

    function onClose(): void {
      settle(null)
    }

    function onData(chunk: Buffer): void {
      bytesRead += chunk.length
      pending += chunk.toString('utf8')
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const codexHome = readCodexHomeFromLine(pending.slice(0, newline).trim())
        pending = pending.slice(newline + 1)
        if (codexHome !== null) {
          settle(codexHome)
          return
        }
        newline = pending.indexOf('\n')
      }
      if (bytesRead > MAX_STDOUT_BYTES) {
        settle(null)
      }
    }

    child.on('error', onFailure)
    child.on('close', onClose)
    child.stdin.on('error', onFailure)
    child.stdout.on('data', onData)
    if (options.signal) {
      if (options.signal.aborted) {
        settle(null)
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdin.write(initializeRequest())
  })
}
