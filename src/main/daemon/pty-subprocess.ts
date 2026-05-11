import * as pty from 'node-pty'
import { statSync } from 'fs'
import { win32 as pathWin32 } from 'path'
import type { SubprocessHandle } from './session'
import { DaemonProtocolError } from './types'
import {
  getAttributionShellLaunchConfig,
  getShellReadyLaunchConfig,
  resolvePtyShellPath
} from './shell-ready'
import { isValidPtySize, normalizePtySize } from './daemon-pty-size'
import {
  ensureNodePtySpawnHelperExecutable,
  getNodePtySpawnHelperCandidates
} from '../providers/local-pty-utils'
import { resolveWindowsShellLaunchArgs } from '../providers/windows-shell-args'
import { resolveEffectiveWindowsPowerShell } from '../providers/windows-powershell'
import { isPwshAvailable } from '../pwsh'

export type PtySubprocessOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  command?: string
  /** Explicit shell executable path/basename the renderer asked for.
   *  Overrides env.COMSPEC / env.SHELL resolution inside the daemon so a user
   *  who picks "New WSL terminal" from the "+" menu actually gets WSL. */
  shellOverride?: string
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
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

function formatMissingDaemonPathError(kind: 'helper' | 'cwd', path: string): DaemonProtocolError {
  const detailName = kind === 'helper' ? 'helper' : 'cwd'
  const step = kind === 'helper' ? 'posix_spawn' : 'daemon_cwd'
  return new DaemonProtocolError(
    `Daemon's ${kind === 'helper' ? 'node-pty install' : 'working directory'} is gone ` +
      `(worktree deleted?). Restart Orca. node-pty: ${step} failed: ENOENT ` +
      `(errno 2, No such file or directory) - ${detailName}='${path}'`
  )
}

function preflightMacNodePtySpawnEnvironment(): void {
  if (process.platform !== 'darwin') {
    return
  }

  let daemonCwd: string
  try {
    daemonCwd = process.cwd()
    if (!statSync(daemonCwd).isDirectory()) {
      throw formatMissingDaemonPathError('cwd', daemonCwd)
    }
  } catch (error) {
    if (error instanceof DaemonProtocolError) {
      throw error
    }
    throw formatMissingDaemonPathError('cwd', '<unavailable>')
  }

  let candidates: string[]
  try {
    candidates = getNodePtySpawnHelperCandidates()
  } catch {
    throw formatMissingDaemonPathError('helper', '<unresolved>')
  }

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return
      }
    } catch {
      // Try the next node-pty native location.
    }
  }

  throw formatMissingDaemonPathError('helper', candidates[0] ?? '<unresolved>')
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
    TERM_PROGRAM_VERSION: process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
    // Why: opt tools (Claude Code, ls --hyperlink, etc.) into emitting OSC 8
    // hyperlinks. The `supports-hyperlinks` npm package gates on a hard-coded
    // TERM_PROGRAM allowlist (iTerm.app / WezTerm / vscode) and returns false
    // for TERM_PROGRAM=Orca, so callers drop OSC 8 output entirely and emit
    // bare text instead. xterm.js in Orca parses OSC 8 and the pane's
    // linkHandler routes clicks, so forcing the advertisement is safe and
    // restores clickable refs like `owner/repo#123` / `PR#123`.
    FORCE_HYPERLINK: '1'
  } as Record<string, string>

  env.LANG ??= 'en_US.UTF-8'

  // Why: the shellOverride from the "+" menu (or persisted default shell
  // setting, relayed by main) takes priority over env.COMSPEC — otherwise
  // Windows always resolves to cmd.exe (COMSPEC) or PowerShell by fallback,
  // no matter which shell the user actually picked.
  let shellPath = opts.shellOverride || resolvePtyShellPath(env)
  let shellArgs: string[]
  let spawnCwd = opts.cwd || getDefaultCwd()

  if (process.platform === 'win32') {
    const normalizedShellFamily = pathWin32.basename(shellPath).toLowerCase()
    // Why: daemon spawn requests can carry either a canonical shell family
    // (`powershell.exe`) or a concrete PowerShell executable path from a
    // one-off override. Normalize both forms back to the PowerShell family so
    // the shared resolver can still fall back to inbox powershell.exe when
    // pwsh.exe was requested but is unavailable.
    const shouldResolvePowerShellFamily =
      opts.terminalWindowsPowerShellImplementation !== undefined ||
      pathWin32.basename(shellPath) === shellPath
    shellPath = shouldResolvePowerShellFamily
      ? (resolveEffectiveWindowsPowerShell({
          shellFamily:
            normalizedShellFamily === 'powershell.exe' || normalizedShellFamily === 'pwsh.exe'
              ? 'powershell.exe'
              : normalizedShellFamily === 'cmd.exe' || normalizedShellFamily === 'wsl.exe'
                ? normalizedShellFamily
                : undefined,
          implementation: opts.terminalWindowsPowerShellImplementation,
          pwshAvailable: isPwshAvailable()
        }) ?? shellPath)
      : shellPath
    // Why: matches LocalPtyProvider — CMD needs chcp 65001, PowerShell needs
    // $PROFILE dot-sourcing, WSL needs a --bash entry with a translated cwd.
    // Reuse the same shared launch-args helper after resolving the effective
    // PowerShell executable so daemon-backed terminals preserve parity with the
    // in-process PTY path.
    const resolved = resolveWindowsShellLaunchArgs(shellPath, spawnCwd, getDefaultCwd())
    shellArgs = resolved.shellArgs
    spawnCwd = resolved.effectiveCwd
  } else {
    // Why: any Orca-injected overlay env that user rc files can clobber
    // needs the wrapper so the post-rc restore line runs.
    const shellLaunch = opts.command
      ? getShellReadyLaunchConfig(shellPath)
      : env.ORCA_ATTRIBUTION_SHIM_DIR ||
          env.ORCA_OPENCODE_CONFIG_DIR ||
          env.ORCA_PI_CODING_AGENT_DIR
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
  preflightMacNodePtySpawnEnvironment()

  const proc = pty.spawn(shellPath, shellArgs, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: spawnCwd,
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
  let disposed = false
  proc.onExit(() => {
    dead = true
    // Why: UnixTerminal.destroy() registers `_socket.once('close', () => this.kill('SIGHUP'))`
    // (unixTerminal.js:219-229). After the child exits, the master socket's
    // 'close' event can fire before our dispose() path gets to neutralize
    // proc.kill — the child's pid may have already been recycled, so SIGHUP
    // lands on an unrelated process. Neutralizing here, synchronously inside
    // the onExit callback, closes that window: once the child is reaped,
    // proc.kill is a no-op no matter which teardown ordering wins.
    // Windows is excluded because WindowsTerminal.destroy relies on kill() to
    // close the ConPTY agent — neutralizing would leak the agent + fds.
    if (process.platform !== 'win32') {
      ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
    }
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
      // Why: once the child has been reaped (dead=true via onExit) or dispose
      // has run, proc.pid refers to a recycled pid. Sending SIGKILL would
      // terminate an unrelated process. The fd release is handled by
      // dispose()/destroy(); forceKill is strictly for signalling a live child.
      if (dead) {
        return
      }
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
      // Why: same recycled-pid hazard as forceKill. Once dead, silently drop
      // the signal rather than risk sending it to an unrelated process.
      if (dead) {
        return
      }
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
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      dead = true
      onDataCb = null
      onExitCb = null
      // Why: UnixTerminal.destroy() registers `_socket.once('close', () => this.kill('SIGHUP'))`
      // (unixTerminal.js:219-229). The socket close fires asynchronously; by then
      // the child may have exited and its pid been recycled to an unrelated
      // process. Without this neutralization, SIGHUP can be delivered to a
      // Chrome tab, editor, or other user process — silent cross-app corruption.
      // `_socket.destroy()` still releases the fd; only the dangerous SIGHUP is
      // removed.
      //
      // Platform guard: WindowsTerminal.destroy implements the ConPTY close by
      // CALLING `this.kill()` via `_deferNoArgs` (windowsTerminal.js:141-146).
      // Neutralizing kill on Windows turns destroy() into a no-op and leaks the
      // ConPTY agent. The SIGHUP hazard is POSIX-only, so the guard is too.
      if (process.platform !== 'win32') {
        ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
      }
      try {
        ;(proc as unknown as { destroy?: () => void }).destroy?.()
      } catch {
        /* swallow — already torn down, or native-side error we can't recover from */
      }
    }
  }
}
