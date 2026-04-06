import { basename } from 'path'
import { type BrowserWindow, ipcMain } from 'electron'
import * as pty from 'node-pty'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

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

      let shellPath: string
      let shellArgs: string[]
      if (process.platform === 'win32') {
        shellPath = process.env.COMSPEC || 'powershell.exe'
        shellArgs = []
      } else {
        shellPath = process.env.SHELL || '/bin/zsh'
        shellArgs = ['-l']
      }

      const defaultCwd =
        process.platform === 'win32'
          ? process.env.USERPROFILE || process.env.HOMEPATH || 'C:\\'
          : process.env.HOME || '/'

      const ptyProcess = pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: args.cols,
        rows: args.rows,
        cwd: args.cwd || defaultCwd,
        env: {
          ...process.env,
          ...args.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'Orca',
          FORCE_HYPERLINK: '1'
        } as Record<string, string>
      })

      ptyProcesses.set(id, ptyProcess)
      ptyShellName.set(id, basename(shellPath))
      ptyLoadGeneration.set(id, loadGeneration)
      runtime?.onPtySpawned(id)

      ptyProcess.onData((data) => {
        runtime?.onPtyData(id, data, Date.now())
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:data', { id, data })
        }
      })

      ptyProcess.onExit(({ exitCode }) => {
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
