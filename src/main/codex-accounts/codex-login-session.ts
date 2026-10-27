import { join } from 'node:path'
import type { WindowsHostInteractiveLoginSpawn } from '../../shared/windows-interactive-login-spawn'
import { buildWindowsHostInteractiveLoginSpawn } from '../../shared/windows-interactive-login-spawn'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../shared/codex-auth-errors'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { resolveCodexCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'
import { runWslProcess } from '../wsl/wsl-runner'
import { parseCodexLoginAuthUrl } from './codex-login-auth-url'
import { DEVICE_AUTH_TIMEOUT_MS, parseCodexDeviceAuthPrompt } from './codex-device-auth-prompt'
import { loginAuthChanged, readLoginAuthSnapshot } from './codex-login-auth-snapshot'
import {
  buildWslCodexAvailabilityScript,
  buildWslCodexLoginArgs,
  WSL_CODEX_AVAILABILITY_TIMEOUT_MS
} from './wsl-codex-command'

// Allow copied-link sign-ins to finish across browsers and password managers.
const LOGIN_TIMEOUT_MS = 180_000
const MAX_LOGIN_OUTPUT_CHARS = 4_000
const WINDOWS_LOGIN_AUTH_POLL_INTERVAL_MS = 500
const WINDOWS_LOGIN_POST_AUTH_EXIT_GRACE_MS = 5_000

type LoginOutputStream = {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  off(event: 'data', listener: (chunk: Buffer) => void): unknown
}

export type CodexLoginChild = {
  stdout: LoginOutputStream | null
  stderr: LoginOutputStream | null
  pid?: number
  exitCode: number | null
  signalCode: string | null
  kill(): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'close', listener: (code: number | null) => void): unknown
}

export type CodexLoginSpawnRequest = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  stdio: WindowsHostInteractiveLoginSpawn['stdio'] | ['ignore', 'pipe', 'pipe']
}

type CodexLoginSessionDependencies = {
  wslCommand: string
  spawn: (request: CodexLoginSpawnRequest) => CodexLoginChild
  killProcessTree: (
    child: CodexLoginChild,
    interactiveLogin?: WindowsHostInteractiveLoginSpawn | null
  ) => void
  /** Registers the handle that abandons this login; the caller clears it. */
  setCancel: (cancel: () => boolean) => void
  /** The browser link codex printed, published as soon as it is complete. */
  onAuthUrl: (url: string) => void
  /** Opens a WSL login's link on this computer; absent where Orca cannot open one. */
  openWslAuthUrl?: ((url: string) => void) | null
  /** Runs `codex login --device-auth` on a Linux/macOS host for a person on another device. */
  deviceAuth?: { onPrompt: (prompt: { url: string; userCode: string }) => void }
}

type LoginCancellation = {
  isCancelled: () => boolean
  setSpawnedCancel: (cancel: () => boolean) => void
}

export async function runCodexLoginSession(
  managedHomePath: string,
  dependencies: CodexLoginSessionDependencies
): Promise<void> {
  let cancelSpawnedLogin: (() => boolean) | null = null
  let cancelled = false
  dependencies.setCancel(() => {
    // Latch only accepted cancellation so a refused attempt cannot disable later cancellation.
    if (cancelled || cancelSpawnedLogin?.() === false) {
      return false
    }
    // Remember pre-spawn cancellation so it prevents the browser from opening.
    cancelled = true
    return true
  })
  await runCodexLoginProcess(managedHomePath, dependencies, {
    isCancelled: () => cancelled,
    setSpawnedCancel: (cancel) => {
      cancelSpawnedLogin = cancel
    }
  })
}

async function runCodexLoginProcess(
  managedHomePath: string,
  dependencies: CodexLoginSessionDependencies,
  cancellation: LoginCancellation
): Promise<void> {
  const wslInfo = parseWslUncPath(managedHomePath)
  const deviceAuth = dependencies.deviceAuth ?? null
  const loginTimeoutMs = deviceAuth ? DEVICE_AUTH_TIMEOUT_MS : LOGIN_TIMEOUT_MS
  if (wslInfo) {
    await assertWslCodexCliAvailable(wslInfo)
  }
  // Reauthentication requires changed credential bytes; avoid pre-spawn UNC reads for WSL.
  const initialAuthSnapshot = wslInfo
    ? null
    : readLoginAuthSnapshot(join(managedHomePath, 'auth.json'))
  const hasAuthBaseline = !wslInfo
  if (cancellation.isCancelled()) {
    throw new Error(CODEX_LOGIN_CANCELLED_MESSAGE)
  }

  // Stock WSL distros may lack a browser opener.
  const openAuthUrl = wslInfo ? (dependencies.openWslAuthUrl ?? null) : null

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const spawnConfig = wslInfo
      ? {
          command: dependencies.wslCommand,
          args: buildWslCodexLoginArgs(wslInfo.distro, wslInfo.linuxPath, {
            orcaOpensSignInLink: openAuthUrl !== null
          }),
          env: process.env,
          codexCommand: 'codex',
          interactiveLogin: null
        }
      : createHostLoginSpawn(managedHomePath, deviceAuth !== null)
    const child = dependencies.spawn({
      command: spawnConfig.command,
      args: spawnConfig.args,
      env: spawnConfig.env,
      stdio: spawnConfig.interactiveLogin
        ? spawnConfig.interactiveLogin.stdio
        : ['ignore', 'pipe', 'pipe']
    })

    let settled = false
    let output = ''
    const appendOutput = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`
      if (output.length > MAX_LOGIN_OUTPUT_CHARS) {
        output = output.slice(-MAX_LOGIN_OUTPUT_CHARS)
      }
    }

    // Browser link is on stderr, device-auth on stdout; per-stream buffers stop interleaving splits.
    let publishedAuthUrl = false
    const readLoginStream = (): ((chunk: Buffer) => void) => {
      let text = ''
      return (chunk) => {
        appendOutput(chunk)
        if (publishedAuthUrl) {
          return
        }
        text = `${text}${chunk.toString()}`.slice(-MAX_LOGIN_OUTPUT_CHARS)
        if (deviceAuth) {
          const prompt = parseCodexDeviceAuthPrompt(text)
          if (prompt) {
            publishedAuthUrl = true
            deviceAuth.onPrompt(prompt)
          }
          return
        }
        const authUrl = parseCodexLoginAuthUrl(text)
        if (authUrl) {
          publishedAuthUrl = true
          dependencies.onAuthUrl(authUrl)
          openAuthUrl?.(authUrl)
        }
      }
    }
    const [readStdout, readStderr] = [readLoginStream(), readLoginStream()]

    let timeout: ReturnType<typeof setTimeout> | null = null
    let authWatchInterval: ReturnType<typeof setInterval> | null = null
    let postAuthExitTimeout: ReturnType<typeof setTimeout> | null = null
    let loginTreeKilledAfterAuth = false
    const authJsonPath = join(managedHomePath, 'auth.json')
    const cleanupListeners = (): void => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      if (authWatchInterval) {
        clearInterval(authWatchInterval)
        authWatchInterval = null
      }
      if (postAuthExitTimeout) {
        clearTimeout(postAuthExitTimeout)
        postAuthExitTimeout = null
      }
      child.stdout?.off('data', readStdout)
      child.stderr?.off('data', readStderr)
      child.off('error', onError)
      child.off('close', onClose)
      spawnConfig.interactiveLogin?.cleanup?.()
    }

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      callback()
    }

    cancellation.setSpawnedCancel(() => {
      // Rejecting after credential changes would roll back an authenticated home.
      // Without a baseline, an existing WSL credential cannot justify refusing cancellation.
      const alreadyAuthenticated =
        hasAuthBaseline &&
        loginAuthChanged(initialAuthSnapshot, readLoginAuthSnapshot(authJsonPath))
      if (settled || alreadyAuthenticated) {
        return false
      }
      dependencies.killProcessTree(child, spawnConfig.interactiveLogin)
      settle(() => rejectPromise(new Error(CODEX_LOGIN_CANCELLED_MESSAGE)))
      return true
    })

    const timeoutError = new Error('Codex sign-in took too long to finish. Please try again.')
    timeout = setTimeout(() => {
      dependencies.killProcessTree(child, spawnConfig.interactiveLogin)
      settle(() => rejectPromise(timeoutError))
    }, loginTimeoutMs)

    // After credentials change, stop lingering Windows login processes that hold home files open.
    if (process.platform === 'win32' && !wslInfo) {
      authWatchInterval = setInterval(() => {
        if (!loginAuthChanged(initialAuthSnapshot, readLoginAuthSnapshot(authJsonPath))) {
          return
        }
        if (authWatchInterval) {
          clearInterval(authWatchInterval)
          authWatchInterval = null
        }
        postAuthExitTimeout = setTimeout(() => {
          loginTreeKilledAfterAuth = true
          dependencies.killProcessTree(child, spawnConfig.interactiveLogin)
        }, WINDOWS_LOGIN_POST_AUTH_EXIT_GRACE_MS)
      }, WINDOWS_LOGIN_AUTH_POLL_INTERVAL_MS)
    }

    const onError = (error: Error): void => {
      settle(() => {
        const isEnoent = (error as NodeJS.ErrnoException).code === 'ENOENT'
        // ENOENT can mean the CLI or its Node interpreter is missing.
        const isBareCommand = spawnConfig.codexCommand === 'codex'
        const message = isEnoent
          ? isBareCommand
            ? 'Codex CLI not found.'
            : 'Codex CLI found but could not run — Node.js may not be in your PATH.'
          : error.message
        rejectPromise(new Error(message))
      })
    }

    const onClose = (code: number | null): void => {
      settle(() => {
        // A forced post-auth exit remains successful unless credentials are definitively absent.
        // An unreadable snapshot cannot revoke success and trigger destructive rollback.
        if (
          code === 0 ||
          (loginTreeKilledAfterAuth && readLoginAuthSnapshot(authJsonPath) !== null)
        ) {
          resolvePromise()
          return
        }
        const trimmedOutput = output.trim()
        rejectPromise(
          new Error(
            trimmedOutput
              ? `Codex login failed: ${trimmedOutput}`
              : `Codex login exited with code ${code ?? 'unknown'}.`
          )
        )
      })
    }

    child.stdout?.on('data', readStdout)
    child.stderr?.on('data', readStderr)
    child.on('error', onError)
    child.on('close', onClose)
  })
}

function createHostLoginSpawn(
  managedHomePath: string,
  deviceAuth: boolean
): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  codexCommand: string
  interactiveLogin: WindowsHostInteractiveLoginSpawn | null
} {
  const codexCommand = resolveCodexCommand()
  const loginArgs = deviceAuth ? ['login', '--device-auth'] : ['login']
  // Windows login needs a console to read paste-code and device-auth prompts.
  const interactiveLogin =
    process.platform === 'win32'
      ? buildWindowsHostInteractiveLoginSpawn(codexCommand, loginArgs)
      : null
  const { spawnCmd, spawnArgs } = interactiveLogin
    ? { spawnCmd: interactiveLogin.command, spawnArgs: interactiveLogin.args }
    : getSpawnArgsForWindows(codexCommand, loginArgs)
  return {
    command: spawnCmd,
    args: spawnArgs,
    env: withCliRuntimeOnPath(codexCommand, { ...process.env, CODEX_HOME: managedHomePath }),
    codexCommand,
    interactiveLogin
  }
}

async function assertWslCodexCliAvailable(wslInfo: {
  distro: string
  linuxPath: string
}): Promise<void> {
  // Include the login PATH so nvm-installed CLIs can be found.
  const result = await runWslProcess({
    distro: wslInfo.distro,
    loginPath: 'preferred',
    script: buildWslCodexAvailabilityScript(),
    // POSIX command lookup; declared because the payload is opaque here.
    shell: 'sh',
    timeoutMs: WSL_CODEX_AVAILABILITY_TIMEOUT_MS
  })
  if (result.code !== 0 && !result.environmentResolved) {
    // An unresolved login environment cannot prove the CLI is absent (#9725).
    throw new Error('Could not check the Codex CLI in WSL. Try again.')
  }
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `Codex CLI is not available in WSL ${wslInfo.distro}. Install Codex in that distro or switch Account location to Windows.`,
      { cause: new Error(result.stderr.trim() || `codex lookup exited with ${result.code}`) }
    )
  }
}
