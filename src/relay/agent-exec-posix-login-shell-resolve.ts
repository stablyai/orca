import { spawn, type ChildProcess } from 'node:child_process'
import { basename, posix } from 'node:path'

const LOGIN_SHELL_RESOLVE_TIMEOUT_MS = 5_000
// Why: rc/profile files can print without bound (motd, version-manager
// chatter). The lookup only ever needs one path, so cap what we buffer and
// fail closed past it rather than letting the relay grow for five seconds.
const LOGIN_SHELL_RESOLVE_MAX_STDOUT_BYTES = 64 * 1024
// Why: csh/tcsh reject combined -lc; sh/dash don't need login mode. Mirrors
// src/main/ssh/ssh-login-shell-command.ts, duplicated because the relay ships
// to remote hosts and can't import from src/main.
const COMMAND_ONLY_LOGIN_SHELLS = new Set(['sh', 'dash', 'csh', 'tcsh'])

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function isBareBinaryName(binary: string): boolean {
  return basename(binary) === binary
}

export function isEnoentSpawnError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' || /ENOENT/.test(error.message)
}

// Why: a plain `spawn(binary, ...)` only sees the relay process's own PATH, so
// a binary installed only via the remote user's shell rc/profile files (the
// common case for version-managed or manually-PATH'd CLIs like `opencode`)
// spawns ENOENT even though an interactive login resolves it fine. Resolve
// through a bounded, non-interactive `command -v` lookup — not by running the
// actual command inside a shell — so stdout stays clean and a hanging rc file
// can't wedge the real exec. Mirrors the Node-resolution fallback in
// src/main/ssh/ssh-remote-node-resolution.ts.
// Why: `command -v` prints the resolved path last, after anything a login
// profile echoed on the way in, so the first line is not reliably the answer.
// Aliases and shell builtins print non-path text ("alias foo='...'", "foo"),
// which must never reach spawn() as a binary.
function lookupResultPath(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const last = lines.at(-1)
  return last && posix.isAbsolute(last) ? last : null
}

export function resolvePosixBinaryViaLoginShell(
  binary: string,
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; signal?: AbortSignal } = {}
): Promise<string | null> {
  const { cwd, signal } = options
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null)
      return
    }
    const shell = env.SHELL || '/bin/sh'
    const shellName = basename(shell)
    const mode = shellName && COMMAND_ONLY_LOGIN_SHELLS.has(shellName) ? '-c' : '-lc'

    let child: ChildProcess
    try {
      child = spawn(shell, [mode, `command -v ${shellQuote(binary)}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        // Why: the retry exec runs in the caller's cwd, and a login profile can
        // answer differently per directory (direnv, nvm's .nvmrc, asdf), quite
        // apart from relative PATH entries. The lookup has to ask from there.
        cwd,
        // Why: the profile can background work of its own. Killing the shell
        // PID alone leaves those children behind, so the lookup leads its own
        // process group and the whole group is signalled below.
        detached: true,
        // Why: without this the lookup runs against the relay's own PATH while
        // the retry exec runs against spawnEnv, so `command -v` can answer for
        // a different environment than the one that will run the binary.
        env
      })
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    let stdoutBytes = 0
    let settled = false
    const kill = (): void => {
      try {
        // Negative pid signals the whole group, which detached: true made this
        // child the leader of. Falls back to the single child if the group is
        // already gone.
        if (child.pid) {
          process.kill(-child.pid, 'SIGKILL')
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already exited */
        }
      }
    }
    const finish = (result: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    // Why: the caller's cancel and timeout paths abandon the exec, but this
    // lookup owns a login shell of its own — without this it keeps running for
    // up to the full timeout after the caller has already settled.
    const onAbort = (): void => {
      kill()
      finish(null)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      kill()
      finish(null)
    }, LOGIN_SHELL_RESOLVE_TIMEOUT_MS)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > LOGIN_SHELL_RESOLVE_MAX_STDOUT_BYTES) {
        kill()
        finish(null)
        return
      }
      stdout += chunk.toString('utf-8')
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (code !== 0) {
        finish(null)
        return
      }
      finish(lookupResultPath(stdout))
    })
  })
}
