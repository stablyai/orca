/* eslint-disable max-lines -- Why: PTY IPC is intentionally centralized in one
main-process module so spawn-time environment scoping, lifecycle cleanup,
foreground-process inspection, and renderer IPC stay behind a single audited
boundary. Splitting it by line count would scatter tightly coupled terminal
process behavior across files without a cleaner ownership seam. */
import { basename, win32 as pathWin32 } from 'path'
import {
  existsSync,
  accessSync,
  statSync,
  chmodSync,
  mkdirSync,
  writeFileSync,
  constants as fsConstants
} from 'fs'
import { app, type BrowserWindow, ipcMain } from 'electron'
import * as pty from 'node-pty'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parseWslPath } from '../wsl'
import { openCodeHookService } from '../opencode/hook-service'
import { piTitlebarExtensionService } from '../pi/titlebar-extension-service'

let ptyCounter = 0
const ptyProcesses = new Map<string, pty.IPty>()
/** Basename of the shell binary each PTY was spawned with (e.g. "zsh"). */
const ptyShellName = new Map<string, string>()
// Why: node-pty's onData/onExit register native NAPI ThreadSafeFunction
// callbacks. If the PTY is killed without disposing these listeners, the
// stale callbacks survive into node::FreeEnvironment() where NAPI attempts
// to invoke/clean them up on a destroyed environment, triggering a SIGABRT
// via Napi::Error::ThrowAsJavaScriptException. Storing and calling the
// disposables before proc.kill() prevents the use-after-free crash.
const ptyDisposables = new Map<string, { dispose: () => void }[]>()

// Track which "page load generation" each PTY belongs to.
// When the renderer reloads, we only kill PTYs from previous generations,
// not ones spawned during the current page load. This prevents a race
// condition where did-finish-load fires after PTYs have already been
// created by the new page, killing them and leaving blank terminals.
let loadGeneration = 0
const ptyLoadGeneration = new Map<string, number>()
let didEnsureSpawnHelperExecutable = false
let didEnsureShellReadyWrappers = false

function quotePosixSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const STARTUP_COMMAND_READY_MAX_WAIT_MS = 1500
const OSC_133_A = '\x1b]133;A'

type ShellReadyScanState = {
  matchPos: number
  heldBytes: string
}

function createShellReadyScanState(): ShellReadyScanState {
  return { matchPos: 0, heldBytes: '' }
}

function scanForShellReady(
  state: ShellReadyScanState,
  data: string
): { output: string; matched: boolean } {
  let output = ''

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i] as string
    if (state.matchPos < OSC_133_A.length) {
      if (ch === OSC_133_A[state.matchPos]) {
        state.heldBytes += ch
        state.matchPos += 1
      } else {
        output += state.heldBytes
        state.heldBytes = ''
        state.matchPos = 0
        if (ch === OSC_133_A[0]) {
          state.heldBytes = ch
          state.matchPos = 1
        } else {
          output += ch
        }
      }
    } else if (ch === '\x07') {
      const remaining = data.slice(i + 1)
      state.heldBytes = ''
      state.matchPos = 0
      return { output: output + remaining, matched: true }
    } else {
      state.heldBytes += ch
    }
  }

  return { output, matched: false }
}

function getShellReadyWrapperRoot(): string {
  return `${app.getPath('userData')}/shell-ready`
}

export function getBashShellReadyRcfileContent(): string {
  return `# Orca bash shell-ready wrapper
[[ -f /etc/profile ]] && source /etc/profile
if [[ -f "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -f "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -f "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
# Why: preserve bash's normal login-shell contract. Many users already source
# ~/.bashrc from ~/.bash_profile; forcing ~/.bashrc again here would duplicate
# PATH edits, hooks, and prompt init in Orca startup-command shells.
# Why: append the marker through PROMPT_COMMAND so it fires after the login
# startup files have rebuilt the prompt, matching Superset's "shell ready"
# contract without re-running user rc files.
__orca_prompt_mark() {
  printf "\\033]133;A\\007"
}
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=("\${PROMPT_COMMAND[@]}" "__orca_prompt_mark")
else
  _orca_prev_prompt_command="\${PROMPT_COMMAND}"
  if [[ -n "\${_orca_prev_prompt_command}" ]]; then
    PROMPT_COMMAND="\${_orca_prev_prompt_command};__orca_prompt_mark"
  else
    PROMPT_COMMAND="__orca_prompt_mark"
  fi
fi
`
}

function ensureShellReadyWrappers(): void {
  if (didEnsureShellReadyWrappers || process.platform === 'win32') {
    return
  }
  didEnsureShellReadyWrappers = true

  const root = getShellReadyWrapperRoot()
  const zshDir = `${root}/zsh`
  const bashDir = `${root}/bash`

  const zshEnv = `# Orca zsh shell-ready wrapper
export ORCA_ORIG_ZDOTDIR="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$ORCA_ORIG_ZDOTDIR/.zshenv" ]] && source "$ORCA_ORIG_ZDOTDIR/.zshenv"
export ZDOTDIR=${quotePosixSingle(zshDir)}
`
  const zshProfile = `# Orca zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$_orca_home/.zprofile" ]] && source "$_orca_home/.zprofile"
`
  const zshRc = `# Orca zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
if [[ -o interactive && -f "$_orca_home/.zshrc" ]]; then
  source "$_orca_home/.zshrc"
fi
`
  const zshLogin = `# Orca zsh shell-ready wrapper
_orca_home="\${ORCA_ORIG_ZDOTDIR:-$HOME}"
if [[ -o interactive && -f "$_orca_home/.zlogin" ]]; then
  source "$_orca_home/.zlogin"
fi
# Why: emit OSC 133;A only after the user's startup hooks finish so Orca knows
# the prompt is actually ready for a long startup command paste.
__orca_prompt_mark() {
  printf "\\033]133;A\\007"
}
precmd_functions=(\${precmd_functions[@]} __orca_prompt_mark)
`
  const bashRc = getBashShellReadyRcfileContent()

  const files = [
    [`${zshDir}/.zshenv`, zshEnv],
    [`${zshDir}/.zprofile`, zshProfile],
    [`${zshDir}/.zshrc`, zshRc],
    [`${zshDir}/.zlogin`, zshLogin],
    [`${bashDir}/rcfile`, bashRc]
  ] as const

  for (const [path, content] of files) {
    const dir = path.slice(0, path.lastIndexOf('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, content, 'utf8')
    chmodSync(path, 0o644)
  }
}

function getShellReadyLaunchConfig(shellPath: string): {
  args: string[] | null
  env: Record<string, string>
  supportsReadyMarker: boolean
} {
  const shellName = basename(shellPath).toLowerCase()

  if (shellName === 'zsh') {
    ensureShellReadyWrappers()
    return {
      args: ['-l'],
      env: {
        ORCA_ORIG_ZDOTDIR: process.env.ZDOTDIR || process.env.HOME || '',
        ZDOTDIR: `${getShellReadyWrapperRoot()}/zsh`
      },
      supportsReadyMarker: true
    }
  }

  if (shellName === 'bash') {
    ensureShellReadyWrappers()
    return {
      args: ['--rcfile', `${getShellReadyWrapperRoot()}/bash/rcfile`],
      env: {},
      supportsReadyMarker: true
    }
  }

  return {
    args: null,
    env: {},
    supportsReadyMarker: false
  }
}

function writeStartupCommandWhenShellReady(
  readyPromise: Promise<void>,
  proc: pty.IPty,
  startupCommand: string,
  onExit: (cleanup: () => void) => void
): void {
  let sent = false

  const cleanup = (): void => {
    sent = true
  }

  const flush = (): void => {
    if (sent) {
      return
    }
    sent = true
    // Why: run startup commands inside the same interactive shell Orca keeps
    // open for the pane. Spawning `shell -c <command>; exec shell -l` would
    // avoid the race, but it would also replace the session after the agent
    // exits and break "stay in this terminal" workflows.
    const payload = startupCommand.endsWith('\n') ? startupCommand : `${startupCommand}\n`
    // Why: startup commands are usually long, quoted agent launches. Writing
    // them in one PTY call after the shell-ready barrier avoids the incremental
    // paste behavior that still dropped characters in practice.
    proc.write(payload)
  }

  readyPromise.then(flush)
  onExit(cleanup)
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
  clearPtyRegistryState(id)
}

function clearPtyRegistryState(id: string): void {
  ptyProcesses.delete(id)
  ptyShellName.delete(id)
  ptyLoadGeneration.delete(id)
}

function killPtyProcess(id: string, proc: pty.IPty): boolean {
  // Why: node-pty's listener disposables must be torn down before proc.kill()
  // on every explicit teardown path, not just app quit. Some kills happen
  // during reload/manual-close flows where waiting for later state cleanup is
  // too late to stop the stale NAPI callbacks from surviving into shutdown.
  disposePtyListeners(id)
  let killed = true
  try {
    proc.kill()
  } catch {
    killed = false
  }
  // Why: once an explicit kill path decides this PTY is done, we must clear
  // the bookkeeping maps even if node-pty reports the process was already
  // gone. Leaving the stale registry entry behind makes later lookups think
  // the PTY is still live even though runtime teardown already ran.
  clearPtyRegistryState(id)
  clearProviderPtyState(id)
  return killed
}

function clearProviderPtyState(id: string): void {
  // Why: OpenCode and Pi both allocate PTY-scoped runtime state outside the
  // node-pty process table. Centralizing provider cleanup avoids drift where a
  // new teardown path forgets to remove one provider's overlay/hook state.
  openCodeHookService.clearPty(id)
  piTitlebarExtensionService.clearPty(id)
}

function getShellValidationError(shellPath: string): string | null {
  if (!existsSync(shellPath)) {
    return (
      `Shell "${shellPath}" does not exist. ` +
      `Set a valid SHELL environment variable or install zsh/bash.`
    )
  }
  try {
    accessSync(shellPath, fsConstants.X_OK)
  } catch {
    return `Shell "${shellPath}" is not executable. Check file permissions.`
  }
  return null
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (didEnsureSpawnHelperExecutable || process.platform === 'win32') {
    return
  }
  didEnsureSpawnHelperExecutable = true

  try {
    const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal.js')
    const packageRoot =
      basename(unixTerminalPath) === 'unixTerminal.js'
        ? unixTerminalPath.replace(/[/\\]lib[/\\]unixTerminal\.js$/, '')
        : unixTerminalPath
    const candidates = [
      `${packageRoot}/build/Release/spawn-helper`,
      `${packageRoot}/build/Debug/spawn-helper`,
      `${packageRoot}/prebuilds/${process.platform}-${process.arch}/spawn-helper`
    ].map((candidate) =>
      candidate
        .replace('app.asar/', 'app.asar.unpacked/')
        .replace('node_modules.asar/', 'node_modules.asar.unpacked/')
    )

    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        continue
      }
      const mode = statSync(candidate).mode
      if ((mode & 0o111) !== 0) {
        return
      }
      // Why: node-pty's Unix backend launches this helper before the requested
      // shell binary. Some package-manager/install paths strip the execute bit
      // from the prebuilt helper, which makes every PTY spawn fail with the
      // misleading "posix_spawnp failed" shell error even when /bin/zsh exists.
      chmodSync(candidate, mode | 0o755)
      return
    }
  } catch (error) {
    console.warn(
      `[pty] Failed to ensure node-pty spawn-helper is executable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function registerPtyHandlers(
  mainWindow: BrowserWindow,
  runtime?: OrcaRuntimeService,
  getSelectedCodexHomePath?: () => string | null
): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('pty:spawn')
  ipcMain.removeHandler('pty:resize')
  ipcMain.removeHandler('pty:kill')
  ipcMain.removeHandler('pty:hasChildProcesses')
  ipcMain.removeHandler('pty:getForegroundProcess')
  ipcMain.removeAllListeners('pty:write')

  // Kill orphaned PTY processes from previous page loads when the renderer reloads.
  // PTYs tagged with the current loadGeneration were spawned during THIS page load
  // and must be preserved — only kill PTYs from earlier generations.
  mainWindow.webContents.on('did-finish-load', () => {
    for (const [id, proc] of ptyProcesses) {
      const gen = ptyLoadGeneration.get(id) ?? -1
      if (gen < loadGeneration) {
        killPtyProcess(id, proc)
        // Why: notify runtime so the agent detector can close out any live
        // agent sessions. Without this, killed PTYs would remain in the
        // detector's liveAgents map and accumulate inflated durations.
        runtime?.onPtyExit(id, -1)
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
      if (!killPtyProcess(ptyId, proc)) {
        return false
      }
      runtime?.onPtyExit(ptyId, -1)
      return true
    }
  })

  ipcMain.handle(
    'pty:spawn',
    (
      _event,
      args: {
        cols: number
        rows: number
        cwd?: string
        env?: Record<string, string>
        command?: string
      }
    ) => {
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
      let shellReadyLaunch: {
        args: string[] | null
        env: Record<string, string>
        supportsReadyMarker: boolean
      } | null = null
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
        // Why: use path.win32.basename so backslash-separated Windows paths
        // are parsed correctly even when tests mock process.platform on Linux CI.
        const shellBasename = pathWin32.basename(shellPath).toLowerCase()
        // Why: On CJK Windows (Chinese, Japanese, Korean), the console code page
        // defaults to the system ANSI code page (e.g. 936/GBK for Chinese).
        // ConPTY encodes its output pipe using this code page, but node-pty
        // always decodes as UTF-8. Without switching to code page 65001 (UTF-8),
        // multi-byte CJK characters are garbled because the GBK/Shift-JIS/EUC-KR
        // byte sequences are misinterpreted as UTF-8. This is especially visible
        // with split-screen terminals where multiple ConPTY instances amplify the
        // issue. Setting the code page at shell startup ensures all subsequent
        // output — including from child processes — uses UTF-8.
        if (shellBasename === 'cmd.exe') {
          shellArgs = ['/K', 'chcp 65001 > nul']
        } else if (shellBasename === 'powershell.exe' || shellBasename === 'pwsh.exe') {
          // Why: `-NoExit -Command` alone skips the user's $PROFILE, breaking
          // custom prompts (oh-my-posh, starship), aliases, and PSReadLine
          // configuration. Dot-sourcing $PROFILE first restores the normal
          // startup experience. The try/catch ensures a broken profile (e.g.
          // terminating errors from strict-mode violations or failing module
          // imports) cannot prevent the encoding commands from executing —
          // otherwise the CJK fix would silently fail for those users.
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
        // Why: startup commands can pass env overrides for the PTY. Prefer an
        // explicit SHELL override when present, but still validate/fallback it
        // exactly like the inherited process shell so stale config can't brick
        // terminal creation.
        shellPath = args.env?.SHELL || process.env.SHELL || '/bin/zsh'
        shellReadyLaunch = args.command ? getShellReadyLaunchConfig(shellPath) : null
        shellArgs = shellReadyLaunch?.args ?? ['-l']
        effectiveCwd = cwd
        validationCwd = cwd
      }

      ensureNodePtySpawnHelperExecutable()

      if (!existsSync(validationCwd)) {
        throw new Error(
          `Working directory "${validationCwd}" does not exist. ` +
            `It may have been deleted or is on an unmounted volume.`
        )
      }
      if (!statSync(validationCwd).isDirectory()) {
        throw new Error(`Working directory "${validationCwd}" is not a directory.`)
      }

      const selectedCodexHomePath = getSelectedCodexHomePath?.() ?? null
      const spawnEnv = {
        ...process.env,
        ...args.env,
        ...shellReadyLaunch?.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'Orca',
        FORCE_HYPERLINK: '1'
      } as Record<string, string>

      const openCodeHookEnv = openCodeHookService.buildPtyEnv(id)
      if (spawnEnv.OPENCODE_CONFIG_DIR) {
        // Why: OPENCODE_CONFIG_DIR is a singular extra config root. Replacing a
        // user-provided directory would silently hide their custom OpenCode
        // config, so preserve it and fall back to title-only detection there.
        delete openCodeHookEnv.OPENCODE_CONFIG_DIR
      }
      Object.assign(spawnEnv, openCodeHookEnv)
      // Why: PI_CODING_AGENT_DIR owns Pi's full config/session root. Build a
      // PTY-scoped overlay from the caller's chosen root so Pi sessions keep
      // their user state without sharing a mutable overlay across terminals.
      Object.assign(
        spawnEnv,
        piTitlebarExtensionService.buildPtyEnv(id, spawnEnv.PI_CODING_AGENT_DIR)
      )

      // Why: the selected Codex account should affect Codex launched inside
      // Orca terminals too, not just Orca's background quota fetches. Inject
      // the managed CODEX_HOME only into this PTY environment so the override
      // stays scoped to Orca terminals instead of mutating the app process or
      // the user's external shells.
      if (selectedCodexHomePath) {
        spawnEnv.CODEX_HOME = selectedCodexHomePath
      }
      // Why: When Electron is launched from Finder (not a terminal), the process
      // does not inherit the user's shell locale settings. Without an explicit
      // UTF-8 locale, multi-byte characters (e.g. em dashes U+2014) are
      // misinterpreted by the PTY and rendered as garbled sequences like "�~@~T".
      // We default LANG to en_US.UTF-8 but let the inherited or caller-provided
      // env override it so user locale preferences are respected.
      spawnEnv.LANG ??= 'en_US.UTF-8'

      // Why: On Windows, LANG alone does not control the console code page.
      // Programs like Python and Node.js check their own encoding env vars
      // independently. PYTHONUTF8=1 makes Python use UTF-8 for stdio regardless
      // of the Windows console code page, preventing garbled CJK output from
      // Python scripts run inside the terminal.
      if (process.platform === 'win32') {
        spawnEnv.PYTHONUTF8 ??= '1'
      }

      let ptyProcess: pty.IPty | undefined
      let primaryError: string | null = null
      if (process.platform !== 'win32') {
        primaryError = getShellValidationError(shellPath)
      }

      if (!primaryError) {
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
          // not caught by the validation above (e.g. architecture mismatch
          // of the native addon, PTY allocation failure, or resource limits).
          primaryError = err instanceof Error ? err.message : String(err)
        }
      }

      if (!ptyProcess && process.platform !== 'win32') {
        // Why: a stale login shell path (common after Homebrew/bash changes)
        // should not brick Orca terminals. Fall back to system shells so the
        // user still gets a working terminal while the bad SHELL config remains.
        const configuredShellPath = shellPath
        const fallbackShells = ['/bin/zsh', '/bin/bash', '/bin/sh'].filter(
          (s) => s !== configuredShellPath
        )
        for (const fallback of fallbackShells) {
          if (getShellValidationError(fallback)) {
            continue
          }
          try {
            // Why: set SHELL to the fallback *before* spawning so the child
            // process inherits the correct value. Leaving the stale original
            // SHELL in the env would confuse shell startup logic and any
            // subprocesses that inspect $SHELL.
            shellReadyLaunch = args.command ? getShellReadyLaunchConfig(fallback) : null
            spawnEnv.SHELL = fallback
            Object.assign(spawnEnv, shellReadyLaunch?.env ?? {})
            ptyProcess = pty.spawn(fallback, shellReadyLaunch?.args ?? ['-l'], {
              name: 'xterm-256color',
              cols: args.cols,
              rows: args.rows,
              cwd: effectiveCwd,
              env: spawnEnv
            })
            console.warn(
              `[pty] Primary shell "${configuredShellPath}" failed (${primaryError ?? 'unknown error'}), fell back to "${fallback}"`
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
          `Failed to spawn shell "${shellPath}": ${primaryError ?? 'unknown error'} (${diag}). ` +
            `If this persists, please file an issue.`
        )
      }

      if (process.platform !== 'win32') {
        // Why: after a successful fallback, update spawnEnv.SHELL to match what
        // was actually launched. The value was already set inside the fallback loop
        // before spawn, but we also need shellPath to reflect the fallback for the
        // ptyShellName map below. (Primary-path spawns already have the correct
        // SHELL from process.env / args.env.)
        spawnEnv.SHELL = shellPath
      }
      const proc = ptyProcess
      ptyProcesses.set(id, proc)
      ptyShellName.set(id, basename(shellPath))
      ptyLoadGeneration.set(id, loadGeneration)
      runtime?.onPtySpawned(id)

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
        runtime?.onPtyData(id, data, Date.now())
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:data', { id, data })
        }
      })

      const onExitDisposable = proc.onExit(({ exitCode }) => {
        if (shellReadyTimeout) {
          clearTimeout(shellReadyTimeout)
          shellReadyTimeout = null
        }
        startupCommandCleanup?.()
        clearPtyState(id)
        clearProviderPtyState(id)
        runtime?.onPtyExit(id, exitCode)
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('pty:exit', { id, code: exitCode })
        }
      })

      ptyDisposables.set(id, [onDataDisposable, onExitDisposable])

      if (args.command) {
        writeStartupCommandWhenShellReady(shellReadyPromise, proc, args.command, (cleanup) => {
          startupCommandCleanup = cleanup
        })
      }

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
      killPtyProcess(args.id, proc)
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

  ipcMain.handle('pty:getForegroundProcess', (_event, args: { id: string }): string | null => {
    const proc = ptyProcesses.get(args.id)
    if (!proc) {
      return null
    }
    try {
      // Why: live Codex-session actions must key off the PTY foreground process,
      // not the tab title. Agent CLIs do not reliably emit stable OSC titles,
      // so title-based detection misses real Codex sessions that still need a
      // restart after account switching.
      return proc.process || null
    } catch {
      // .process can throw if the PTY fd is already closed.
      return null
    }
  })
}

/**
 * Kill all PTY processes. Call on app quit.
 */
export function killAllPty(): void {
  for (const [id, proc] of ptyProcesses) {
    killPtyProcess(id, proc)
  }
}
