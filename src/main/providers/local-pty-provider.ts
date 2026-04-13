import { basename, win32 as pathWin32 } from 'path'
import { existsSync } from 'fs'
import * as pty from 'node-pty'
import { parseWslPath } from '../wsl'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types'
import {
  ensureNodePtySpawnHelperExecutable,
  validateWorkingDirectory,
  spawnShellWithFallback
} from './local-pty-utils'

let ptyCounter = 0
const ptyProcesses = new Map<string, pty.IPty>()
const ptyShellName = new Map<string, string>()

let loadGeneration = 0
const ptyLoadGeneration = new Map<string, number>()

type DataCallback = (payload: { id: string; data: string }) => void
type ExitCallback = (payload: { id: string; code: number }) => void

const dataListeners = new Set<DataCallback>()
const exitListeners = new Set<ExitCallback>()

function clearPtyState(id: string): void {
  ptyProcesses.delete(id)
  ptyShellName.delete(id)
  ptyLoadGeneration.delete(id)
}

function safeKillAndClean(id: string, proc: pty.IPty): void {
  try {
    proc.kill()
  } catch {
    /* Process may already be dead */
  }
  clearPtyState(id)
}

export type LocalPtyProviderOptions = {
  buildSpawnEnv?: (id: string, baseEnv: Record<string, string>) => Record<string, string>
  onSpawned?: (id: string) => void
  onExit?: (id: string, code: number) => void
  onData?: (id: string, data: string, timestamp: number) => void
}

export class LocalPtyProvider implements IPtyProvider {
  private opts: LocalPtyProviderOptions

  constructor(opts: LocalPtyProviderOptions = {}) {
    this.opts = opts
  }

  /** Reconfigure the provider with new hooks (e.g. after window re-creation). */
  configure(opts: LocalPtyProviderOptions): void {
    this.opts = opts
  }

  async spawn(args: PtySpawnOptions): Promise<PtySpawnResult> {
    const id = String(++ptyCounter)

    const defaultCwd =
      process.platform === 'win32'
        ? process.env.USERPROFILE || process.env.HOMEPATH || 'C:\\'
        : process.env.HOME || '/'

    const cwd = args.cwd || defaultCwd
    const wslInfo = process.platform === 'win32' ? parseWslPath(cwd) : null

    let shellPath: string
    let shellArgs: string[]
    let effectiveCwd: string
    let validationCwd: string
    if (wslInfo) {
      const escapedCwd = wslInfo.linuxPath.replace(/'/g, "'\\''")
      shellPath = 'wsl.exe'
      shellArgs = ['-d', wslInfo.distro, '--', 'bash', '-c', `cd '${escapedCwd}' && exec bash -l`]
      effectiveCwd = process.env.USERPROFILE || process.env.HOMEPATH || 'C:\\'
      validationCwd = cwd
    } else if (process.platform === 'win32') {
      shellPath = process.env.COMSPEC || 'powershell.exe'
      // Why: use path.win32.basename so backslash-separated Windows paths
      // are parsed correctly even when tests mock process.platform on Linux CI.
      const shellBasename = pathWin32.basename(shellPath).toLowerCase()
      // Why: On CJK Windows (Chinese, Japanese, Korean), the console code page
      // defaults to the system ANSI code page (e.g. 936/GBK for Chinese).
      // ConPTY encodes its output pipe using this code page, but node-pty
      // always decodes as UTF-8. Without switching to code page 65001 (UTF-8),
      // multi-byte CJK characters are garbled because the GBK/Shift-JIS/EUC-KR
      // byte sequences are misinterpreted as UTF-8.
      if (shellBasename === 'cmd.exe') {
        shellArgs = ['/K', 'chcp 65001 > nul']
      } else if (shellBasename === 'powershell.exe' || shellBasename === 'pwsh.exe') {
        // Why: `-NoExit -Command` alone skips the user's $PROFILE, breaking
        // custom prompts (oh-my-posh, starship), aliases, and PSReadLine
        // configuration. Dot-sourcing $PROFILE first restores the normal
        // startup experience.
        shellArgs = [
          '-NoExit',
          '-Command',
          'try { . $PROFILE } catch {}; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8'
        ]
      } else {
        shellArgs = []
      }
      effectiveCwd = cwd
      validationCwd = cwd
    } else {
      shellPath = args.env?.SHELL || process.env.SHELL || '/bin/zsh'
      shellArgs = ['-l']
      effectiveCwd = cwd
      validationCwd = cwd
    }

    ensureNodePtySpawnHelperExecutable()
    validateWorkingDirectory(validationCwd)

    const spawnEnv: Record<string, string> = {
      ...process.env,
      ...args.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Orca',
      FORCE_HYPERLINK: '1'
    } as Record<string, string>

    spawnEnv.LANG ??= 'en_US.UTF-8'

    // Why: On Windows, LANG alone does not control the console code page.
    // Programs like Python and Node.js check their own encoding env vars
    // independently. PYTHONUTF8=1 makes Python use UTF-8 for stdio regardless
    // of the Windows console code page, preventing garbled CJK output from
    // Python scripts run inside the terminal.
    if (process.platform === 'win32') {
      spawnEnv.PYTHONUTF8 ??= '1'
    }

    const finalEnv = this.opts.buildSpawnEnv ? this.opts.buildSpawnEnv(id, spawnEnv) : spawnEnv

    const spawnResult = spawnShellWithFallback({
      shellPath,
      shellArgs,
      cols: args.cols,
      rows: args.rows,
      cwd: effectiveCwd,
      env: finalEnv,
      ptySpawn: pty.spawn
    })
    shellPath = spawnResult.shellPath

    if (process.platform !== 'win32') {
      finalEnv.SHELL = shellPath
    }

    const proc = spawnResult.process
    ptyProcesses.set(id, proc)
    ptyShellName.set(id, basename(shellPath))
    ptyLoadGeneration.set(id, loadGeneration)
    this.opts.onSpawned?.(id)

    proc.onData((data) => {
      this.opts.onData?.(id, data, Date.now())
      for (const cb of dataListeners) {
        cb({ id, data })
      }
    })

    proc.onExit(({ exitCode }) => {
      clearPtyState(id)
      this.opts.onExit?.(id, exitCode)
      for (const cb of exitListeners) {
        cb({ id, code: exitCode })
      }
    })

    return { id }
  }

  // Local PTYs are always attached -- no-op. Remote providers use this to resubscribe.
  async attach(_id: string): Promise<void> {}
  write(id: string, data: string): void {
    ptyProcesses.get(id)?.write(data)
  }
  resize(id: string, cols: number, rows: number): void {
    ptyProcesses.get(id)?.resize(cols, rows)
  }

  async shutdown(id: string, _immediate: boolean): Promise<void> {
    const proc = ptyProcesses.get(id)
    if (!proc) {
      return
    }
    try {
      // node-pty's kill() sends SIGHUP on Unix. The onExit handler
      // registered in spawn() handles cleanup and listener notification.
      proc.kill()
    } catch {
      // Process may already be dead — ensure cleanup still happens.
      clearPtyState(id)
      this.opts.onExit?.(id, -1)
      for (const cb of exitListeners) {
        cb({ id, code: -1 })
      }
    }
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    const proc = ptyProcesses.get(id)
    if (!proc) {
      return
    }
    try {
      process.kill(proc.pid, signal)
    } catch {
      /* Process may already be dead */
    }
  }

  async getCwd(id: string): Promise<string> {
    if (!ptyProcesses.has(id)) {
      throw new Error(`PTY ${id} not found`)
    }
    // node-pty doesn't expose cwd; would need /proc on Linux or lsof on macOS
    return ''
  }
  async getInitialCwd(_id: string): Promise<string> {
    return ''
  }
  async clearBuffer(_id: string): Promise<void> {
    /* handled client-side in xterm.js */
  }
  acknowledgeDataEvent(_id: string, _charCount: number): void {
    /* no flow control for local */
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    const proc = ptyProcesses.get(id)
    if (!proc) {
      return false
    }
    try {
      const foreground = proc.process
      const shell = ptyShellName.get(id)
      if (!shell) {
        return true
      }
      return foreground !== shell
    } catch {
      return false
    }
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    const proc = ptyProcesses.get(id)
    if (!proc) {
      return null
    }
    try {
      return proc.process || null
    } catch {
      return null
    }
  }

  async serialize(_ids: string[]): Promise<string> {
    return '{}'
  }
  async revive(_state: string): Promise<void> {
    /* re-spawning handles local revival */
  }

  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    return Array.from(ptyProcesses.entries()).map(([id, proc]) => ({
      id,
      cwd: '',
      title: proc.process || ptyShellName.get(id) || 'shell'
    }))
  }

  async getDefaultShell(): Promise<string> {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/zsh'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    if (process.platform === 'win32') {
      return [
        { name: 'PowerShell', path: 'powershell.exe' },
        { name: 'Command Prompt', path: 'cmd.exe' }
      ]
    }
    const shells = ['/bin/zsh', '/bin/bash', '/bin/sh']
    return shells.filter((s) => existsSync(s)).map((s) => ({ name: basename(s), path: s }))
  }

  onData(callback: DataCallback): () => void {
    dataListeners.add(callback)
    return () => dataListeners.delete(callback)
  }

  // Local PTYs don't replay -- this is for remote reconnection
  onReplay(_callback: (payload: { id: string; data: string }) => void): () => void {
    return () => {}
  }

  onExit(callback: ExitCallback): () => void {
    exitListeners.add(callback)
    return () => exitListeners.delete(callback)
  }

  // ─── Local-only helpers (not part of IPtyProvider interface) ───────

  /** Kill orphaned PTYs from previous page loads. */
  killOrphanedPtys(currentGeneration: number): { id: string }[] {
    const killed: { id: string }[] = []
    for (const [id, proc] of ptyProcesses) {
      if ((ptyLoadGeneration.get(id) ?? -1) < currentGeneration) {
        safeKillAndClean(id, proc)
        killed.push({ id })
      }
    }
    return killed
  }

  /** Advance the load generation counter (called on renderer reload). */
  advanceGeneration(): number {
    return ++loadGeneration
  }

  /** Get a writable reference to a PTY (for runtime controller). */
  getPtyProcess(id: string): pty.IPty | undefined {
    return ptyProcesses.get(id)
  }

  /** Kill all PTYs. Call on app quit. */
  killAll(): void {
    for (const [id, proc] of ptyProcesses) {
      safeKillAndClean(id, proc)
    }
  }
}
