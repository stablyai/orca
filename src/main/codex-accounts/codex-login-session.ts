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
import { loginAuthChanged, readLoginAuthSnapshot } from './codex-login-auth-snapshot'
import {
  buildWslCodexAvailabilityScript,
  buildWslCodexLoginArgs,
  WSL_CODEX_AVAILABILITY_TIMEOUT_MS
} from './wsl-codex-command'

// Why: matches Claude's window. Signing in through a copied link — a second
// browser, a password manager, an incognito window — routinely outlasts two
// minutes, and the old 120s deadline failed those users mid-flow.
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
    // Why: only an accepted cancel latches. A spawned login that refuses —
    // because it already authenticated — must stay cancellable, or the Cancel
    // button and the next add both go dead for the rest of the deadline.
    if (cancelled || cancelSpawnedLogin?.() === false) {
      return false
    }
    // A cancel before the spawn has no tree to kill; the pre-spawn probe reads
    // this flag instead of opening a browser nobody is waiting for.
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
  if (wslInfo) {
    await assertWslCodexCliAvailable(wslInfo)
  }
  // Why: reauthentication starts with an existing auth.json. Only new auth
  // bytes prove this login completed; existence alone would kill the
  // Windows OAuth flow five seconds after it opened.
  // WSL keeps its baseline unread — the UNC round trip belongs nowhere in the
  // pre-spawn path — so there is nothing to compare a WSL home against.
  const initialAuthSnapshot = wslInfo
    ? null
    : readLoginAuthSnapshot(join(managedHomePath, 'auth.json'))
  const hasAuthBaseline = !wslInfo
  if (cancellation.isCancelled()) {
    throw new Error(CODEX_LOGIN_CANCELLED_MESSAGE)
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const spawnConfig = wslInfo
      ? {
          command: dependencies.wslCommand,
          args: buildWslCodexLoginArgs(wslInfo.distro, wslInfo.linuxPath),
          env: process.env,
          codexCommand: 'codex',
          interactiveLogin: null
        }
      : createHostLoginSpawn(managedHomePath)
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

    // Why its own buffer: a stderr chunk interleaved between two halves of the
    // link would end the match early, and the published link never changes.
    let stdoutText = ''
    let publishedAuthUrl = false
    const publishAuthUrl = (chunk: Buffer): void => {
      if (publishedAuthUrl) {
        return
      }
      stdoutText = `${stdoutText}${chunk.toString()}`.slice(-MAX_LOGIN_OUTPUT_CHARS)
      const authUrl = parseCodexLoginAuthUrl(stdoutText)
      if (authUrl) {
        publishedAuthUrl = true
        dependencies.onAuthUrl(authUrl)
      }
    }

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
      child.stdout?.off('data', appendOutput)
      child.stdout?.off('data', publishAuthUrl)
      child.stderr?.off('data', appendOutput)
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
      // Why: once codex has written new credential bytes the sign-in already
      // succeeded, and rejecting here would send the caller's rollback at the
      // home it just authenticated. Nothing left to cancel — let it settle.
      // Without a baseline (WSL) an existing auth.json says nothing about this
      // login, so refusing on it would make a WSL reauth uncancellable.
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
    }, LOGIN_TIMEOUT_MS)

    // Why: on Windows the codex login CLI can linger after writing auth.json,
    // and its open handles on the managed home (log/codex-login.log) make the
    // post-login file operations fail with ENOTEMPTY. Once auth.json exists,
    // give the tree a short grace period to exit, then force it down.
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
        // Why: ENOENT is ambiguous — missing codex binary or missing node in PATH; a resolved full path implies node is missing.
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
        // Why: the post-auth tree kill is a success path — auth.json already
        // exists and codex only failed to exit on its own, so the forced
        // non-zero exit must not surface as a login failure.
        // Why: the kill only arms after the watcher observed new credential
        // bytes, so an unreadable auth.json here is a lock, not a failed login.
        // Only a definitive absence may revoke that verdict — reading a lock as
        // failure sends the caller's rollback at a home that just authenticated.
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

    child.stdout?.on('data', appendOutput)
    child.stdout?.on('data', publishAuthUrl)
    child.stderr?.on('data', appendOutput)
    child.on('error', onError)
    child.on('close', onClose)
  })
}

function createHostLoginSpawn(managedHomePath: string): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  codexCommand: string
  interactiveLogin: WindowsHostInteractiveLoginSpawn | null
} {
  const codexCommand = resolveCodexCommand()
  // Why: Windows host login needs a real console; otherwise inherit/hide
  // leaves the child unable to read a paste-code / device-auth prompt.
  const interactiveLogin =
    process.platform === 'win32'
      ? buildWindowsHostInteractiveLoginSpawn(codexCommand, ['login'])
      : null
  const { spawnCmd, spawnArgs } = interactiveLogin
    ? { spawnCmd: interactiveLogin.command, spawnArgs: interactiveLogin.args }
    : getSpawnArgsForWindows(codexCommand, ['login'])
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
  // This is a PATH lookup, so it needs the login PATH: an nvm-installed codex
  // lives nowhere else. Marking it 'none' reports a working install as absent.
  const result = await runWslProcess({
    distro: wslInfo.distro,
    loginPath: 'preferred',
    script: buildWslCodexAvailabilityScript(),
    // POSIX command lookup; declared because the payload is opaque here.
    shell: 'sh',
    timeoutMs: WSL_CODEX_AVAILABILITY_TIMEOUT_MS
  })
  if (result.code !== 0 && !result.environmentResolved) {
    // A miss without the login PATH is "we could not check", not "not
    // installed" -- claiming absence here is #9725.
    throw new Error('Could not check the Codex CLI in WSL. Try again.')
  }
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `Codex CLI is not available in WSL ${wslInfo.distro}. Install Codex in that distro or switch Account location to Windows.`,
      { cause: new Error(result.stderr.trim() || `codex lookup exited with ${result.code}`) }
    )
  }
}
