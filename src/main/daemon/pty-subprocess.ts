import * as pty from 'node-pty'
import type { SubprocessHandle } from './session'
import {
  getAttributionShellLaunchConfig,
  getShellReadyLaunchConfig,
  resolvePtyShellPath
} from './shell-ready'
import { isValidPtySize, normalizePtySize } from './daemon-pty-size'
import { ensureNodePtySpawnHelperExecutable } from '../providers/local-pty-utils'

export type PtySubprocessOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  command?: string
}

function getDefaultCwd(): string {
  if (process.platform !== 'win32') {
    return process.env.HOME || '/'
  }

  // Why: HOMEPATH alone is drive-relative (`\\Users\\name`). Pair it with
  // HOMEDRIVE when USERPROFILE is unavailable so daemon-spawned Windows PTYs
  // still start in a valid absolute home directory.
  if (process.env.USERPROFILE) {
    return process.env.USERPROFILE
  }
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
  }
  return 'C:\\'
}

export function createPtySubprocess(opts: PtySubprocessOptions): SubprocessHandle {
  const size = normalizePtySize(opts.cols, opts.rows)
  const env: Record<string, string> = {
    ...process.env,
    ...opts.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Orca',
    // Why: TUIs feature-gate on TERM_PROGRAM_VERSION. The daemon is forked
    // by main (daemon-init.ts:93) with the parent's env, so ORCA_APP_VERSION
    // — set in src/main/index.ts from app.getVersion() — is inherited here.
    TERM_PROGRAM_VERSION: process.env.ORCA_APP_VERSION ?? '0.0.0-dev'
  } as Record<string, string>

  env.LANG ??= 'en_US.UTF-8'

  const shellPath = resolvePtyShellPath(env)
  let shellArgs: string[]

  if (process.platform === 'win32') {
    shellArgs = []
  } else {
    const shellLaunch = opts.command
      ? getShellReadyLaunchConfig(shellPath)
      : env.ORCA_ATTRIBUTION_SHIM_DIR
        ? getAttributionShellLaunchConfig(shellPath)
        : null
    if (shellLaunch) {
      Object.assign(env, shellLaunch.env)
    }
    shellArgs = shellLaunch?.args ?? ['-l']
  }

  // Why: asar packaging can strip the +x bit from node-pty's spawn-helper
  // binary. The main process fixes this via LocalPtyProvider, but the daemon
  // runs in a separate forked process with its own code path.
  ensureNodePtySpawnHelperExecutable()

  const proc = pty.spawn(shellPath, shellArgs, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: opts.cwd || getDefaultCwd(),
    env
  })

  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null

  proc.onData((data) => onDataCb?.(data))
  proc.onExit(({ exitCode }) => onExitCb?.(exitCode))

  // Why: node-pty's native NAPI layer throws a C++ Napi::Error when
  // write/resize/kill is called on a PTY whose underlying fd is already
  // closed. This happens in the race window between the child process
  // exiting and the JS onExit callback firing. An uncaught Napi::Error
  // propagates to std::terminate, killing the entire daemon process.
  let dead = false
  proc.onExit(() => {
    dead = true
  })

  return {
    pid: proc.pid,
    write: (data) => {
      if (dead) {
        return
      }
      try {
        proc.write(data)
      } catch {
        dead = true
      }
    },
    resize: (cols, rows) => {
      if (dead) {
        return
      }
      if (!isValidPtySize(cols, rows)) {
        return
      }
      try {
        proc.resize(cols, rows)
      } catch {
        dead = true
      }
    },
    kill: () => {
      if (dead) {
        return
      }
      try {
        proc.kill()
      } catch {
        dead = true
      }
    },
    forceKill: () => {
      try {
        process.kill(proc.pid, 'SIGKILL')
      } catch {
        try {
          proc.kill()
        } catch {
          // Process may already be dead
        }
      }
    },
    signal: (sig) => {
      try {
        process.kill(proc.pid, sig)
      } catch {
        // Process may already be dead
      }
    },
    onData: (cb) => {
      onDataCb = cb
    },
    onExit: (cb) => {
      onExitCb = cb
    }
  }
}
