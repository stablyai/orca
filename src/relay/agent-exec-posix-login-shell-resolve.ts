import { spawn, type ChildProcess } from 'node:child_process'

const LOGIN_SHELL_RESOLVE_TIMEOUT_MS = 5_000
// Why: csh/tcsh reject combined -lc; sh/dash don't need login mode. Mirrors
// src/main/ssh/ssh-login-shell-command.ts, duplicated because the relay ships
// to remote hosts and can't import from src/main.
const COMMAND_ONLY_LOGIN_SHELLS = new Set(['sh', 'dash', 'csh', 'tcsh'])

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function isBareBinaryName(binary: string): boolean {
  return !binary.includes('/')
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
export function resolvePosixBinaryViaLoginShell(
  binary: string,
  env: NodeJS.ProcessEnv
): Promise<string | null> {
  return new Promise((resolve) => {
    const shell = env.SHELL || '/bin/sh'
    const shellName = shell.split('/').at(-1)
    const mode = shellName && COMMAND_ONLY_LOGIN_SHELLS.has(shellName) ? '-c' : '-lc'

    let child: ChildProcess
    try {
      child = spawn(shell, [mode, `command -v ${shellQuote(binary)}`], {
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    let settled = false
    const finish = (result: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already exited */
      }
      finish(null)
    }, LOGIN_SHELL_RESOLVE_TIMEOUT_MS)
    timer.unref?.()

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (code !== 0) {
        finish(null)
        return
      }
      const resolved = stdout.split('\n')[0]?.trim()
      finish(resolved ? resolved : null)
    })
  })
}
