import { spawnProcess } from '../../shared/child-process/run-process'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import {
  buildWindowsHostInteractiveLoginSpawn,
  type WindowsHostInteractiveLoginSpawn
} from '../../shared/windows-interactive-login-spawn'
import {
  buildWslExecArgs,
  buildWslLoginShellCommand,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'
import { resolveClaudeCommand } from '../codex-cli/command'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { buildWindowsCommandInvocation } from './windows-command-invocation'
import { terminateClaudeProcess } from './claude-login-process-termination'

const MAX_COMMAND_OUTPUT_CHARS = 4_000
const CLAUDE_AUTH_DENIED_PATTERN =
  /\baccess_denied\b|authorization (?:request )?(?:was )?denied|sign-?in (?:was )?denied|login (?:was )?denied/i

export type ClaudeCommandConfig = {
  windowsPath: string
  linuxPath: string | null
  wslDistro: string | null
}

export type ClaudeCommandOptions = {
  signal?: AbortSignal
  keepStdinOpen?: boolean
  /** BROWSER for Claude, as Claude's own host sees the path. */
  browser?: string
}

export function runClaudeCommandProcess(
  args: string[],
  configDir: ClaudeCommandConfig,
  timeoutMs: number,
  options?: ClaudeCommandOptions
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const isWindowsHostInteractiveLogin =
      process.platform === 'win32' &&
      configDir.linuxPath === null &&
      configDir.wslDistro === null &&
      args[0] === 'auth' &&
      args[1] === 'login'
    // Why lazy: the WSL branch runs `claude` inside the distro, so resolving a
    // host binary there would be wasted filesystem probing for a path never used.
    let cachedHostClaudeCommand: string | null = null
    const hostClaudeCommand = (): string => (cachedHostClaudeCommand ??= resolveClaudeCommand())
    // The native login needs its own visible console, so it runs behind a
    // start /wait wrapper that relays the real login PID back for termination.
    const interactiveLogin = isWindowsHostInteractiveLogin
      ? buildWindowsHostInteractiveLoginSpawn(hostClaudeCommand(), args)
      : null
    const spawnConfig = resolveClaudeInvocation(
      args,
      configDir,
      interactiveLogin,
      hostClaudeCommand,
      options?.browser
    )
    const child = spawnProcess({
      program: spawnConfig.command,
      args: spawnConfig.args,
      env: spawnConfig.env,
      // Why: Claude's browser auth can bind its callback lifetime to stdin.
      // Keeping stdin open prevents hidden managed-login runs from tearing down
      // the local callback server before the browser returns.
      stdio: interactiveLogin
        ? interactiveLogin.stdio
        : [options?.keepStdinOpen ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: spawnConfig.windowsVerbatimArguments
    })
    const stdout = child.stdout
    const stderr = child.stderr
    if (!interactiveLogin && (!stdout || !stderr)) {
      if (options?.keepStdinOpen) {
        child.stdin?.destroy()
      }
      child.kill()
      rejectPromise(new Error('Claude command failed to open output streams.'))
      return
    }
    const completesOnExit =
      process.platform === 'win32' &&
      configDir.linuxPath === null &&
      configDir.wslDistro === null &&
      args[0] === 'auth' &&
      args[1] === 'login'
    const completionEvent = completesOnExit ? 'exit' : 'close'
    let settled = false
    let output = ''
    let timeout: ReturnType<typeof setTimeout> | null = null
    let terminationPending = false

    const cleanupListeners = (): void => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      stdout?.off('data', appendOutput)
      stderr?.off('data', appendOutput)
      child.off('error', onError)
      child.off(completionEvent, onDone)
      options?.signal?.removeEventListener('abort', onAbort)
      interactiveLogin?.cleanup?.()
      if (options?.keepStdinOpen) {
        child.stdin?.destroy()
      }
      if (completesOnExit) {
        stdout?.destroy()
        stderr?.destroy()
      }
    }
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      callback()
    }
    const killChild = (afterKill: () => void): void => {
      if (terminationPending || settled) {
        return
      }
      terminationPending = true
      terminateClaudeProcess(child, interactiveLogin, afterKill)
    }
    const appendOutput = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`
      if (output.length > MAX_COMMAND_OUTPUT_CHARS) {
        output = output.slice(-MAX_COMMAND_OUTPUT_CHARS)
      }
      if (CLAUDE_AUTH_DENIED_PATTERN.test(output)) {
        killChild(() =>
          settle(() => rejectPromise(new Error('Claude sign-in was denied. Please try again.')))
        )
      }
    }
    const onAbort = (): void => {
      killChild(() => settle(() => rejectPromise(new Error('Claude sign-in was cancelled.'))))
    }
    const onError = (error: Error): void => {
      if (!terminationPending) {
        settle(() => rejectPromise(error))
      }
    }
    const onDone = (code: number | null): void => {
      if (terminationPending) {
        return
      }
      settle(() => {
        if (code === 0) {
          resolvePromise(output)
          return
        }
        const trimmedOutput = output.trim()
        rejectPromise(
          new Error(
            trimmedOutput
              ? `Claude command failed: ${trimmedOutput}`
              : `Claude command exited with code ${code ?? 'unknown'}.`
          )
        )
      })
    }

    timeout = setTimeout(() => {
      killChild(() =>
        settle(() => rejectPromise(new Error('Claude sign-in took too long to finish.')))
      )
    }, timeoutMs)
    stdout?.on('data', appendOutput)
    stderr?.on('data', appendOutput)
    child.on('error', onError)
    child.on(completionEvent, onDone)
    if (options?.signal?.aborted) {
      onAbort()
    } else {
      options?.signal?.addEventListener('abort', onAbort, { once: true })
    }
  })
}

type ClaudeSpawnConfig = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  windowsVerbatimArguments: boolean
}

// Why only this variable: account terminals set just CLAUDE_CONFIG_DIR, so Claude keys the login the same way.
function claudeConfigDirEnv(configDir: string, browser: string | undefined): NodeJS.ProcessEnv {
  return browser
    ? { CLAUDE_CONFIG_DIR: configDir, BROWSER: browser }
    : { CLAUDE_CONFIG_DIR: configDir }
}

function wslClaudeCommand(linuxPath: string, args: string[], browser: string | undefined): string {
  const claude = `claude ${args.map(quotePosixShell).join(' ')}`
  const configDir = `CLAUDE_CONFIG_DIR=${quotePosixShell(linuxPath)}`
  if (!browser) {
    return `exec env ${configDir} ${claude}`
  }
  // Why chmod here: a file Orca writes over \\wsl$ arrives without an exec bit; a failure must not stop the login.
  const helper = quotePosixShell(browser)
  return `chmod 700 ${helper}; exec env ${configDir} BROWSER=${helper} ${claude}`
}

function resolveClaudeInvocation(
  args: string[],
  configDir: ClaudeCommandConfig,
  interactiveLogin: WindowsHostInteractiveLoginSpawn | null,
  hostClaudeCommand: () => string,
  browser: string | undefined
): ClaudeSpawnConfig {
  const spawnConfig = interactiveLogin
    ? {
        command: interactiveLogin.command,
        args: interactiveLogin.args,
        env: withCliRuntimeOnPath(hostClaudeCommand(), {
          ...process.env,
          ...claudeConfigDirEnv(configDir.windowsPath, browser)
        }),
        windowsVerbatimArguments: false
      }
    : configDir.linuxPath && configDir.wslDistro
      ? {
          // Same login as the CLI's WSL sign-in: the distro's login shell finds an nvm/mise claude.
          command: resolveWslExecutablePath(),
          args: buildWslExecArgs(configDir.wslDistro, [
            '/bin/sh',
            '-c',
            buildWslLoginShellCommand(wslClaudeCommand(configDir.linuxPath, args, browser))
          ]),
          env: process.env,
          windowsVerbatimArguments: false
        }
      : process.platform === 'win32'
        ? {
            ...buildWindowsCommandInvocation(hostClaudeCommand(), args),
            env: withCliRuntimeOnPath(hostClaudeCommand(), {
              ...process.env,
              ...claudeConfigDirEnv(configDir.windowsPath, browser)
            })
          }
        : {
            command: hostClaudeCommand(),
            args,
            env: withCliRuntimeOnPath(hostClaudeCommand(), {
              ...process.env,
              ...claudeConfigDirEnv(configDir.windowsPath, browser)
            }),
            windowsVerbatimArguments: false
          }
  return spawnConfig
}
