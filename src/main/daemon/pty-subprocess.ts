import * as pty from 'node-pty'
import type { SubprocessHandle } from './session'

export type PtySubprocessOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  command?: string
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

  let shellPath: string
  let shellArgs: string[]

  if (process.platform === 'win32') {
    shellPath = env.COMSPEC || 'powershell.exe'
    shellArgs = []
  } else {
    shellPath = env.SHELL || process.env.SHELL || '/bin/zsh'
    shellArgs = ['-l']
  }

  const defaultCwd =
    process.platform === 'win32'
      ? process.env.USERPROFILE || process.env.HOMEPATH || 'C:\\'
      : process.env.HOME || '/'

  const proc = pty.spawn(shellPath, shellArgs, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd || defaultCwd,
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
