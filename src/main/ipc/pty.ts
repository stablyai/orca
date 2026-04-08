import { basename } from 'path'
import { existsSync, accessSync, statSync, constants as fsConstants } from 'fs'
import { type BrowserWindow, ipcMain } from 'electron'
import * as pty from 'node-pty'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parseWslPath } from '../wsl'

let ptyCounter = 0
const ptyProcesses = new Map<string, pty.IPty>()
/** Basename of the shell binary each PTY was spawned with (e.g. "zsh"). */
const ptyShellName = new Map<string, string>()

// Track which "page load generation" each PTY belongs to.
// When the renderer reloads, we only kill PTYs from previous generations,
// not ones spawned during the current page load. This prevents a race
// condition where did-finish-load fires after PTYs have already been
// created by the new page, killing them and leaving blank terminals.
let loadGeneration = 0
const ptyLoadGeneration = new Map<string, number>()

export function registerPtyHandlers(mainWindow: BrowserWindow, runtime?: OrcaRuntimeService): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('pty:spawn')
  ipcMain.removeHandler('pty:resize')
  ipcMain.removeHandler('pty:kill')
  ipcMain.removeHandler('pty:hasChildProcesses')
  ipcMain.removeAllListeners('pty:write')

  // Kill orphaned PTY processes from previous page loads when the renderer reloads.
  // PTYs tagged with the current loadGeneration were spawned during THIS page load
  // and must be preserved — only kill PTYs from earlier generations.
  mainWindow.webContents.on('did-finish-load', () => {
    for (const [id, proc] of ptyProcesses) {
      const gen = ptyLoadGeneration.get(id) ?? -1
      if (gen < loadGeneration) {
        try {
          proc.kill()
        } catch {
          // Process may already be dead
        }
        ptyProcesses.delete(id)
        ptyShellName.delete(id)
        ptyLoadGeneration.delete(id)
      }
    }
    // Advance generation for the next page load
    loadGeneration++
  })

  runtime?.setPtyController({
    write: (ptyId, data) => {
      const proc = ptyProcesses.get(ptyId)
      if (!proc) {
        return false
      }
      proc.write(data)
      return true
    },
    kill: (ptyId) => {
      const proc = ptyProcesses.get(ptyId)
      if (!proc) {
        return false
      }
      try {
        proc.kill()
      } catch {
        return false
      }
      ptyProcesses.delete(ptyId)
      ptyShellName.delete(ptyId)
      ptyLoadGeneration.delete(ptyId)
      runtime?.onPtyExit(ptyId, -1)
      return true
    }
  })

  ipcMain.handle(
    'pty:spawn',
    (_event, args: { cols: number; rows: number; cwd?: string; env?: Record<string, string> }) => {
      const id = String(++ptyCounter)

      const defaultCwd =
        process.platform === 'win32'
          ? process.env.USERPROFILE || process.env.HOMEPATH || 'C:\\'
          : process.env.HOME || '/'

      const cwd = args.cwd || defaultCwd

      // Why: when the working directory is inside a WSL filesystem, spawn a
      // WSL shell (wsl.exe) instead of a native Windows shell. This gives the
      // user a Linux environment with access to their WSL-installed tools
      // (git, node, etc.) rather than a PowerShell with no WSL toolchain.
      const wslInfo = process.platform === 'win32' ? parseWslPath(cwd) : null

      let shellPath: string
      let shellArgs: string[]
      let effectiveCwd: string
      let validationCwd: string
      if (wslInfo) {
        // Why: use `bash -c "cd ... && exec bash -l"` instead of `--cd` because
        // wsl.exe's --cd flag fails with ERROR_PATH_NOT_FOUND in some Node
        // spawn configurations. The exec replaces the outer bash with a login
        // shell so the user gets their normal shell environment.
        const escapedCwd = wslInfo.linuxPath.replace(/'/g, "'\\''")
        shellPath = 'wsl.exe'
        shellArgs = ['-d', wslInfo.distro, '--', 'bash', '-c', `cd '${escapedCwd}' && exec bash -l`]
        // Why: set cwd to a valid Windows directory so node-pty's native
        // spawn doesn't fail on the UNC path.
        effectiveCwd = process.env.USERPROFILE || process.env.HOMEPATH || 'C:\\'
        // Why: still validate the requested WSL UNC path, not the fallback
        // Windows cwd. Otherwise a deleted/mistyped WSL worktree silently
        // spawns a shell in the home directory and hides the real error.
        validationCwd = cwd
      } else if (process.platform === 'win32') {
        shellPath = process.env.COMSPEC || 'powershell.exe'
        shellArgs = []
        effectiveCwd = cwd
        validationCwd = cwd
      } else {
        shellPath = process.env.SHELL || '/bin/zsh'
        shellArgs = ['-l']
        effectiveCwd = cwd
        validationCwd = cwd
      }

      // Why: node-pty's posix_spawnp error is opaque (no errno). Pre-validate
      // the shell binary and cwd so we can surface actionable diagnostics
      // instead of a bare "posix_spawnp failed" message.
      if (process.platform !== 'win32') {
        if (!existsSync(shellPath)) {
          throw new Error(
            `Shell "${shellPath}" does not exist. ` +
              `Set a valid SHELL environment variable or install zsh/bash.`
          )
        }
        try {
          accessSync(shellPath, fsConstants.X_OK)
        } catch {
          throw new Error(
            `Shell "${shellPath}" is not executable. Check file permissions.`
          )
        }
      }

      if (!existsSync(validationCwd)) {
        throw new Error(
          `Working directory "${validationCwd}" does not exist. ` +
            `It may have been deleted or is on an unmounted volume.`
        )
      }
      if (!statSync(validationCwd).isDirectory()) {
        throw new Error(`Working directory "${validationCwd}" is not a directory.`)
      }

      const spawnEnv = {
        ...process.env,
        ...args.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'Orca',
        FORCE_HYPERLINK: '1'
      } as Record<string, string>

      let ptyProcess: pty.IPty | undefined
      try {
        ptyProcess = pty.spawn(shellPath, shellArgs, {
          name: 'xterm-256color',
          cols: args.cols,
          rows: args.rows,
          cwd: effectiveCwd,
          env: spawnEnv
        })
      } catch (err) {
        // Why: node-pty.spawn can throw if posix_spawnp fails for reasons
        // not caught by the pre-validation above (e.g. architecture mismatch
        // of the native addon, PTY allocation failure, or resource limits).
        // Try common fallback shells before giving up — the user's SHELL
        // env may point to a broken or incompatible binary.
        const primaryError = err instanceof Error ? err.message : String(err)

        if (process.platform !== 'win32') {
          const fallbackShells = ['/bin/zsh', '/bin/bash', '/bin/sh'].filter(
            (s) => s !== shellPath
          )
          for (const fallback of fallbackShells) {
            try {
              accessSync(fallback, fsConstants.X_OK)
            } catch {
              continue
            }
            try {
              ptyProcess = pty.spawn(fallback, ['-l'], {
                name: 'xterm-256color',
                cols: args.cols,
                rows: args.rows,
                cwd: effectiveCwd,
                env: spawnEnv
              })
              // Fallback succeeded — update shellPath for the basename tracking below.
              console.warn(
                `[pty] Primary shell "${shellPath}" failed (${primaryError}), fell back to "${fallback}"`
              )
              shellPath = fallback
              break
            } catch {
              // Fallback also failed — try next.
            }
          }
        }

        if (!ptyProcess) {
          const diag = [
            `shell: ${shellPath}`,
            `cwd: ${effectiveCwd}`,
            `arch: ${process.arch}`,
            `platform: ${process.platform} ${process.getSystemVersion?.() ?? ''}`
          ].join(', ')
          throw new Error(
            `Failed to spawn shell "${shellPath}": ${primaryError} (${diag}). ` +
              `If this persists, please file an issue.`
          )
        }
      }

      // Should be unreachable — the catch block throws when no fallback succeeds.
      if (!ptyProcess) {
        throw new Error('PTY process was not created')
      }
      const proc = ptyProcess
      ptyProcesses.set(id, proc)
      ptyShellName.set(id, basename(shellPath))
      ptyLoadGeneration.set(id, loadGeneration)
      runtime?.onPtySpawned(id)

      proc.onData((data) => {
        runtime?.onPtyData(id, data, Date.now())
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:data', { id, data })
        }
      })

      proc.onExit(({ exitCode }) => {
        ptyProcesses.delete(id)
        ptyShellName.delete(id)
        ptyLoadGeneration.delete(id)
        runtime?.onPtyExit(id, exitCode)
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:exit', { id, code: exitCode })
        }
      })

      return { id }
    }
  )

  ipcMain.on('pty:write', (_event, args: { id: string; data: string }) => {
    const proc = ptyProcesses.get(args.id)
    if (proc) {
      proc.write(args.data)
    }
  })

  ipcMain.handle('pty:resize', (_event, args: { id: string; cols: number; rows: number }) => {
    const proc = ptyProcesses.get(args.id)
    if (proc) {
      proc.resize(args.cols, args.rows)
    }
  })

  ipcMain.handle('pty:kill', (_event, args: { id: string }) => {
    const proc = ptyProcesses.get(args.id)
    if (proc) {
      try {
        proc.kill()
      } catch {
        // Process may already be dead
      }
      ptyProcesses.delete(args.id)
      ptyShellName.delete(args.id)
      ptyLoadGeneration.delete(args.id)
      runtime?.onPtyExit(args.id, -1)
    }
  })

  // Check whether the terminal's foreground process differs from its shell
  // (e.g. the user is running `node server.js`). Uses node-pty's native
  // .process getter which reads the OS process table directly — no external
  // tools like pgrep required.
  ipcMain.handle('pty:hasChildProcesses', (_event, args: { id: string }): boolean => {
    const proc = ptyProcesses.get(args.id)
    if (!proc) {
      return false
    }
    try {
      const foreground = proc.process
      const shell = ptyShellName.get(args.id)
      // If we can't determine the shell name, err on the side of caution.
      if (!shell) {
        return true
      }
      return foreground !== shell
    } catch {
      // .process can throw if the PTY fd is already closed.
      return false
    }
  })
}

/**
 * Kill all PTY processes. Call on app quit.
 */
export function killAllPty(): void {
  for (const [id, proc] of ptyProcesses) {
    try {
      proc.kill()
    } catch {
      // Process may already be dead
    }
    ptyProcesses.delete(id)
    ptyShellName.delete(id)
    ptyLoadGeneration.delete(id)
  }
}
