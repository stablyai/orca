import * as pty from 'node-pty'
import type { SubprocessHandle } from './session'
import { getShellReadyLaunchConfig, resolvePtyShellPath } from './shell-ready'
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
  const env: Record<string, string> = {
    ...process.env,
    ...opts.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Orca'
  } as Record<string, string>

  env.LANG ??= 'en_US.UTF-8'

  const shellPath = resolvePtyShellPath(env)
  let shellArgs: string[]

  if (process.platform === 'win32') {
    shellArgs = []
  } else {
    const shellReadyLaunch = opts.command ? getShellReadyLaunchConfig(shellPath) : null
    if (shellReadyLaunch) {
      Object.assign(env, shellReadyLaunch.env)
    }
    shellArgs = shellReadyLaunch?.args ?? ['-l']
  }

  // Why: asar packaging can strip the +x bit from node-pty's spawn-helper
  // binary. The main process fixes this via LocalPtyProvider, but the daemon
  // runs in a separate forked process with its own code path.
  ensureNodePtySpawnHelperExecutable()

  const proc = pty.spawn(shellPath, shellArgs, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd || getDefaultCwd(),
    env
  })

  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null

  proc.onData((data) => onDataCb?.(data))
  proc.onExit(({ exitCode }) => onExitCb?.(exitCode))

  return {
    pid: proc.pid,
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: () => proc.kill(),
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
