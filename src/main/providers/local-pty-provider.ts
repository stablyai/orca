/* eslint-disable max-lines -- Why: shell-ready startup command integration adds
~70 lines of scanner/promise wiring to spawn(). Splitting the method would scatter
tightly coupled PTY lifecycle logic (scan → ready → write → exit cleanup) across
files without a cleaner ownership seam. */
import { basename } from 'path'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'
import { existsSync } from 'fs'
import * as pty from 'node-pty'
import { parseWslPath, isWslAvailable } from '../wsl'
import {
  injectHistoryEnv,
  updateHistFileForFallback,
  logHistoryInjection
} from '../terminal-history'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types'
import {
  ensureNodePtySpawnHelperExecutable,
  validateWorkingDirectory,
  spawnShellWithFallback
} from './local-pty-utils'
import {
  getAttributionShellLaunchConfig,
  getShellReadyLaunchConfig,
  createShellReadyScanState,
  scanForShellReady,
  writeStartupCommandWhenShellReady,
  STARTUP_COMMAND_READY_MAX_WAIT_MS
} from './local-pty-shell-ready'

let ptyCounter = 0
const ptyProcesses = new Map<string, pty.IPty>()
const ptyShellName = new Map<string, string>()
// Why: node-pty's onData/onExit register native NAPI ThreadSafeFunction
// callbacks. If the PTY is killed without disposing these listeners, the
// stale callbacks survive into node::FreeEnvironment() where NAPI attempts
// to invoke/clean them up on a destroyed environment, triggering a SIGABRT.
const ptyDisposables = new Map<string, { dispose: () => void }[]>()

let loadGeneration = 0
const ptyLoadGeneration = new Map<string, number>()

type DataCallback = (payload: { id: string; data: string }) => void
type ExitCallback = (payload: { id: string; code: number }) => void

const dataListeners = new Set<DataCallback>()
const exitListeners = new Set<ExitCallback>()

function getDefaultCwd(): string {
  if (process.platform !== 'win32') {
    return process.env.HOME || '/'
  }

  // Why: USERPROFILE is not guaranteed in all Windows launch contexts.
  // Falling back to bare HOMEPATH yields a drive-relative path, so combine
  // HOMEDRIVE + HOMEPATH to keep spawned PTYs anchored to the intended home.
  if (process.env.USERPROFILE) {
    return process.env.USERPROFILE
  }
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    return `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
  }
  return 'C:\\'
}

function disposePtyListeners(id: string): void {
  const disposables = ptyDisposables.get(id)
  if (disposables) {
    for (const d of disposables) {
      d.dispose()
    }
    ptyDisposables.delete(id)
  }
}

function clearPtyState(id: string): void {
  disposePtyListeners(id)
  ptyProcesses.delete(id)
  ptyShellName.delete(id)
  ptyLoadGeneration.delete(id)
}

function safeKillAndClean(id: string, proc: pty.IPty): void {
  disposePtyListeners(id)
  try {
    proc.kill()
  } catch {
    /* Process may already be dead */
  }
  clearPtyState(id)
}

export type LocalPtyProviderOptions = {
  buildSpawnEnv?: (id: string, baseEnv: Record<string, string>) => Record<string, string>
  /** Whether worktree-scoped shell history is enabled. When true (or absent)
   *  and a worktreeId is provided, HISTFILE is scoped per-worktree. */
  isHistoryEnabled?: () => boolean
  /** Why: COMSPEC is always cmd.exe on a stock Windows machine, so reading it
   *  directly would ignore the user's shell preference. This callback lets the
   *  IPC layer inject the persisted setting without coupling the provider to the
   *  settings store. Returns undefined when no preference is set. */
  getWindowsShell?: () => string | undefined
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

    const defaultCwd = getDefaultCwd()
    const cwd = args.cwd || defaultCwd
    const wslInfo = process.platform === 'win32' ? parseWslPath(cwd) : null

    let shellPath: string
    let shellArgs: string[]
    let effectiveCwd: string
    let validationCwd: string
    let shellReadyLaunch: ReturnType<typeof getShellReadyLaunchConfig> | null = null
    if (wslInfo) {
      const escapedCwd = wslInfo.linuxPath.replace(/'/g, "'\\''")
      shellPath = 'wsl.exe'
      shellArgs = ['-d', wslInfo.distro, '--', 'bash', '-c', `cd '${escapedCwd}' && exec bash -l`]
      effectiveCwd = getDefaultCwd()
      validationCwd = cwd
    } else if (process.platform === 'win32') {
      // Why: shellOverride lets a single tab open in a different shell than the
      // persisted default (e.g. "New WSL terminal" from the "+" submenu) without
      // changing the user's setting. It takes priority over the setting.
      shellPath =
        args.shellOverride ||
        this.opts.getWindowsShell?.() ||
        process.env.COMSPEC ||
        'powershell.exe'
      // Why: both this path and the daemon-subprocess path must derive the
      // same shellArgs for the same (shell, cwd) pair. The helper keeps CJK
      // UTF-8 setup (chcp 65001), PowerShell $PROFILE dot-sourcing, and the
      // wsl.exe /mnt/<drive> cwd translation in one place.
      const resolved = resolveWindowsShellLaunchArgs(shellPath, cwd, defaultCwd)
      shellArgs = resolved.shellArgs
      effectiveCwd = resolved.effectiveCwd
      validationCwd = resolved.validationCwd
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
      // Why: TUIs feature-gate on TERM_PROGRAM_VERSION (Neovim's termcap
      // autodetection, bat/delta paging hints). Sourced from ORCA_APP_VERSION
      // which main/index.ts seeds from app.getVersion() at startup; the
      // fallback keeps tests and non-Electron runs working.
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
    for (const key of args.envToDelete ?? []) {
      delete spawnEnv[key]
    }

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
    if (!wslInfo && process.platform !== 'win32') {
      const shellLaunch = args.command
        ? getShellReadyLaunchConfig(shellPath)
        : finalEnv.ORCA_ATTRIBUTION_SHIM_DIR
          ? getAttributionShellLaunchConfig(shellPath)
          : null
      if (shellLaunch) {
        Object.assign(finalEnv, shellLaunch.env)
        shellArgs = shellLaunch.args ?? shellArgs
        shellReadyLaunch = args.command ? shellLaunch : null
      }
    }

    // ── Worktree-scoped shell history (§7–§10 of terminal-history-scope-design) ──
    // Why: without this, all worktree terminals share a single global HISTFILE
    // so ArrowUp in worktree B surfaces commands from worktree A.
    const worktreeId = args.worktreeId
    const historyEnabled = worktreeId && (this.opts.isHistoryEnabled?.() ?? true)
    // Resolve the effective shell kind for history injection. For WSL, the
    // outer executable is wsl.exe but the inner login shell is bash.
    const effectiveShellPath = wslInfo ? 'bash' : shellPath
    let historyResult: ReturnType<typeof injectHistoryEnv> | null = null
    if (historyEnabled) {
      historyResult = injectHistoryEnv(finalEnv, worktreeId, effectiveShellPath, cwd)
      logHistoryInjection(worktreeId, historyResult)
    }

    const spawnResult = spawnShellWithFallback({
      shellPath,
      shellArgs,
      cols: args.cols,
      rows: args.rows,
      cwd: effectiveCwd,
      env: finalEnv,
      ptySpawn: pty.spawn,
      getShellReadyConfig: args.command ? (shell) => getShellReadyLaunchConfig(shell) : undefined,
      // Why: if zsh failed and bash took over, HISTFILE still points to
      // zsh_history. Update it *before* spawn so the child inherits the
      // correct filename (see design doc §8).
      onBeforeFallbackSpawn: historyResult?.histFile
        ? (env, fallbackShell) => updateHistFileForFallback(env, fallbackShell)
        : undefined
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

    // Shell-ready startup command support
    let resolveShellReady: (() => void) | null = null
    let shellReadyTimeout: ReturnType<typeof setTimeout> | null = null
    const shellReadyScanState = shellReadyLaunch?.supportsReadyMarker
      ? createShellReadyScanState()
      : null
    const shellReadyPromise = args.command
      ? new Promise<void>((resolve) => {
          resolveShellReady = resolve
        })
      : Promise.resolve()
    const finishShellReady = (): void => {
      if (!resolveShellReady) {
        return
      }
      if (shellReadyTimeout) {
        clearTimeout(shellReadyTimeout)
        shellReadyTimeout = null
      }
      const resolve = resolveShellReady
      resolveShellReady = null
      resolve()
    }
    if (args.command) {
      if (shellReadyLaunch?.supportsReadyMarker) {
        shellReadyTimeout = setTimeout(() => {
          finishShellReady()
        }, STARTUP_COMMAND_READY_MAX_WAIT_MS)
      } else {
        finishShellReady()
      }
    }
    let startupCommandCleanup: (() => void) | null = null

    const disposables: { dispose: () => void }[] = []
    const onDataDisposable = proc.onData((rawData) => {
      let data = rawData
      if (shellReadyScanState && resolveShellReady) {
        const scanned = scanForShellReady(shellReadyScanState, rawData)
        data = scanned.output
        if (scanned.matched) {
          finishShellReady()
        }
      }
      if (data.length === 0) {
        return
      }
      this.opts.onData?.(id, data, Date.now())
      for (const cb of dataListeners) {
        cb({ id, data })
      }
    })
    if (onDataDisposable) {
      disposables.push(onDataDisposable)
    }

    const onExitDisposable = proc.onExit(({ exitCode }) => {
      if (shellReadyTimeout) {
        clearTimeout(shellReadyTimeout)
        shellReadyTimeout = null
      }
      startupCommandCleanup?.()
      clearPtyState(id)
      this.opts.onExit?.(id, exitCode)
      for (const cb of exitListeners) {
        cb({ id, code: exitCode })
      }
    })
    if (onExitDisposable) {
      disposables.push(onExitDisposable)
    }
    ptyDisposables.set(id, disposables)

    if (args.command) {
      writeStartupCommandWhenShellReady(shellReadyPromise, proc, args.command, (cleanup) => {
        startupCommandCleanup = cleanup
      })
    }

    // Why: publish the OS pid so ipc/pty can register the PTY with the memory
    // collector without reaching back into the provider. `proc.pid` may be
    // briefly 0/undefined if node-pty hasn't observed the forked child yet.
    const rawPid = proc.pid
    const pid = typeof rawPid === 'number' && Number.isFinite(rawPid) && rawPid > 0 ? rawPid : null
    return { id, pid }
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
    // Why: disposePtyListeners removes the onExit callback, so the natural
    // exit cleanup path from node-pty won't fire. Cleanup and notification
    // must happen unconditionally after the try/catch.
    // Note: clearPtyState calls disposePtyListeners internally, so we only
    // need to call it once via clearPtyState after killing the process.
    disposePtyListeners(id)
    try {
      proc.kill()
    } catch {
      /* Process may already be dead */
    }
    ptyProcesses.delete(id)
    ptyShellName.delete(id)
    ptyLoadGeneration.delete(id)
    this.opts.onExit?.(id, -1)
    for (const cb of exitListeners) {
      cb({ id, code: -1 })
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
      return this.opts.getWindowsShell?.() || process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/zsh'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    if (process.platform === 'win32') {
      const profiles: { name: string; path: string }[] = [
        { name: 'PowerShell', path: 'powershell.exe' },
        { name: 'Command Prompt', path: 'cmd.exe' }
      ]
      if (isWslAvailable()) {
        profiles.push({ name: 'WSL', path: 'wsl.exe' })
      }
      return profiles
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
