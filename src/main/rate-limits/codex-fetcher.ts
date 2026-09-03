import type { CodexRateLimitResetOutcome, ProviderRateLimits } from '../../shared/rate-limit-types'
import { spawn } from 'node:child_process'
import { isCodexAuthError } from '../../shared/codex-auth-errors'
import { buildWslExecArgs, buildWslLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { resolveCodexCommand } from '../codex-cli/command'
// Why: import from the shared module, not the codex-cli re-export, so a test that
// mocks '../codex-cli/command' does not have to restate this pure helper.
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock
} from '../codex-cli/codex-home-process-lock'
import { isCodexStateDbBackfillPending } from '../codex/codex-state-db'
import { startCodexStateDbBackfillRecoveryInBackground } from '../codex/codex-state-db-backfill-recovery'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { getCmdExePath, getSpawnArgsForWindows } from '../win32-utils'
import { probeCodexAuthPresence } from './codex-auth-presence'
import {
  fetchCodexRateLimitsViaBackend,
  supplementCodexSessionWindow
} from './codex-backend-usage-client'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'
import { abortedCodexRateLimitResult } from './codex-rate-limit-fetch-result'
import { fetchCodexRateLimitsViaPty } from './codex-pty-rate-limit-probe'
import { terminateCodexProbeChild } from './codex-probe-termination'
import {
  consumeCodexRateLimitResetCreditFromBackend,
  supplementCodexRateLimitResetCredits
} from './codex-reset-credit-client'
import {
  readCodexRateLimitsViaRpc,
  type CodexRpcRateLimitChild
} from './codex-rpc-rate-limit-probe'
import {
  getHiddenRateLimitWslCwdSetupCommands,
  resolveHiddenRateLimitPtyCwd
} from './hidden-rate-limit-pty-cwd'
import { quoteHiddenRateLimitShellValue } from './hidden-rate-limit-shell'

const RPC_TIMEOUT_MS = 10_000
const WSL_RPC_TIMEOUT_MS = 25_000
const RPC_INIT_TIMEOUT_MS = 30_000
const WSL_RPC_INIT_TIMEOUT_MS = 40_000

export type FetchCodexRateLimitsOptions = CodexRateLimitFetchOptions

function buildWslCodexCommand(
  codexHomePath: string,
  args: string[],
  isolateRpcStdio: boolean
): { command: string; args: string[] } | null {
  const wslInfo = parseWslUncPath(codexHomePath)
  if (process.platform !== 'win32' || !wslInfo) {
    return null
  }
  const setupCommands = [
    ...getHiddenRateLimitWslCwdSetupCommands(),
    `export CODEX_HOME=${quoteHiddenRateLimitShellValue(wslInfo.linuxPath)}`
  ].join(' && ')
  const execSuffix = `${args.map(quoteHiddenRateLimitShellValue).join(' ')}${
    isolateRpcStdio ? ' <&3 >&4 3<&- 4>&-' : ''
  }`
  const loginShellCommand = buildWslLoginShellCommand(
    [setupCommands, `exec codex ${execSuffix}`].join(' && ')
  )
  const command = isolateRpcStdio
    ? ['exec 3<&0', 'exec 4>&1', 'exec </dev/null', 'exec >/dev/null', loginShellCommand].join('\n')
    : loginShellCommand
  return {
    command: 'wsl.exe',
    args: buildWslExecArgs(wslInfo.distro, ['sh', '-c', command])
  }
}

function processEnvWithoutCodexHome(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CODEX_HOME
  return env
}

function fetchCodexUsage(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init)
}

function fetchCodexResetCredits(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init)
}

function consumeCodexResetCredit(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init)
}

async function fetchViaRpc(options?: CodexRateLimitFetchOptions): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  const codexArgs = [...CODEX_READ_ONLY_APP_SERVER_ARGS]
  const wslCodex = options?.codexHomePath
    ? buildWslCodexCommand(options.codexHomePath, codexArgs, true)
    : null
  const codexCommand = wslCodex ? 'codex' : resolveCodexCommand()
  const { spawnCmd, spawnArgs } = wslCodex
    ? { spawnCmd: wslCodex.command, spawnArgs: wslCodex.args }
    : getSpawnArgsForWindows(codexCommand, codexArgs)
  const spawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    cwd: resolveHiddenRateLimitPtyCwd(),
    windowsHide: true,
    env: withCliRuntimeOnPath(codexCommand, {
      ...(wslCodex ? processEnvWithoutCodexHome() : process.env),
      ...(options?.codexHomePath && !wslCodex ? { CODEX_HOME: options.codexHomePath } : {})
    })
  }
  const child = spawn(spawnCmd, spawnArgs, spawnOptions)
  return readCodexRateLimitsViaRpc({
    child: child as CodexRpcRateLimitChild,
    codexCommand,
    initTimeoutMs: wslCodex ? WSL_RPC_INIT_TIMEOUT_MS : RPC_INIT_TIMEOUT_MS,
    rpcTimeoutMs: wslCodex ? WSL_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS,
    fetchOptions: options,
    terminate: () => terminateCodexProbeChild(child)
  })
}

function resolvePtyCommand(options?: CodexRateLimitFetchOptions) {
  const wslCodex = options?.codexHomePath
    ? buildWslCodexCommand(options.codexHomePath, [], false)
    : null
  const codexCommand = wslCodex ? 'codex' : resolveCodexCommand()
  const isWin32 = process.platform === 'win32'
  return {
    command: wslCodex ? wslCodex.command : isWin32 ? getCmdExePath() : codexCommand,
    args: wslCodex ? wslCodex.args : isWin32 ? ['/d', '/c', codexCommand] : [],
    cwd: resolveHiddenRateLimitPtyCwd(),
    env: withCliRuntimeOnPath(codexCommand, {
      ...(wslCodex ? processEnvWithoutCodexHome() : process.env),
      TERM: 'xterm-256color',
      ...(options?.codexHomePath && !wslCodex ? { CODEX_HOME: options.codexHomePath } : {})
    })
  }
}

export function consumeCodexRateLimitResetCredit(options: {
  codexHomePath?: string | null
  idempotencyKey: string
}): Promise<CodexRateLimitResetOutcome> {
  return consumeCodexRateLimitResetCreditFromBackend(options, consumeCodexResetCredit)
}

async function supplementBackendMetadata(
  limits: ProviderRateLimits,
  options?: CodexRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  const withSession = await supplementCodexSessionWindow(limits, fetchCodexUsage, options)
  return supplementCodexRateLimitResetCredits(withSession, fetchCodexResetCredits, options)
}

function codexUnavailable(error: string, status: 'error' | 'unavailable'): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}

async function fetchWslBackend(
  options: CodexRateLimitFetchOptions
): Promise<ProviderRateLimits | null> {
  try {
    const result = await fetchCodexRateLimitsViaBackend(fetchCodexUsage, options)
    if (options.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    // Why (STA-3445): this is the one path that publishes the backend reading as-is, so the
    // no-window rule the RPC and PTY probes apply has to hold here too. Falling through to
    // those probes beats overwriting the account's last real usage with two nulls.
    return result && (result.session || result.weekly)
      ? supplementCodexRateLimitResetCredits(result, fetchCodexResetCredits, options)
      : null
  } catch {
    return options.signal?.aborted ? abortedCodexRateLimitResult() : null
  }
}

export async function fetchCodexRateLimits(
  options?: FetchCodexRateLimitsOptions
): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  const authPresence = await probeCodexAuthPresence(options?.codexHomePath, {
    signal: options?.signal
  })
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  if (authPresence === 'absent') {
    return codexUnavailable('Codex not signed in', 'unavailable')
  }
  if (authPresence !== 'present') {
    return codexUnavailable(
      authPresence === 'timeout'
        ? 'Timed out while checking Codex sign-in status'
        : 'Codex sign-in status is unavailable',
      'error'
    )
  }
  return withSignedInCodexStatus(await readSignedInCodexRateLimits(options))
}

// Why: `unavailable` is the UI's "provider is not set up" signal — it hides the
// chip and feeds the status bar's "Connect an account" empty state. Everything
// below the auth gate ran against a Codex sign-in Orca already found on disk, so
// a probe that could not run is a failed reading, never an absent account.
function withSignedInCodexStatus(limits: ProviderRateLimits): ProviderRateLimits {
  return limits.status === 'unavailable' ? { ...limits, status: 'error' } : limits
}

async function readSignedInCodexRateLimits(
  options?: FetchCodexRateLimitsOptions
): Promise<ProviderRateLimits> {
  if (options?.codexHomePath && parseWslUncPath(options.codexHomePath)) {
    const backendResult = await fetchWslBackend(options)
    if (backendResult) {
      return options.signal?.aborted ? abortedCodexRateLimitResult() : backendResult
    }
  }

  if (options?.codexHomePath && isCodexStateDbBackfillPending(options.codexHomePath)) {
    void startCodexStateDbBackfillRecoveryInBackground(options.codexHomePath)
    return codexUnavailable(
      'Codex is rebuilding its session index; usage will refresh when recovery finishes',
      'error'
    )
  }

  const homeLockKey = resolveCodexHomeProcessLockKey(options?.codexHomePath)
  try {
    const rpcResult = await withCodexHomeProcessLock(homeLockKey, () => fetchViaRpc(options))
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    if (rpcResult.status === 'ok' || rpcResult.status === 'unavailable') {
      const supplemented = await supplementBackendMetadata(rpcResult, options)
      return options?.signal?.aborted ? abortedCodexRateLimitResult() : supplemented
    }
    if (isCodexAuthError(rpcResult.error) || options?.allowPtyFallback === false) {
      return rpcResult
    }
  } catch {
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    if (options?.allowPtyFallback === false) {
      return codexUnavailable('RPC failed', 'error')
    }
  }

  try {
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    const ptyResult = await withCodexHomeProcessLock(homeLockKey, () =>
      fetchCodexRateLimitsViaPty(() => resolvePtyCommand(options), options)
    )
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    const supplemented = await supplementBackendMetadata(ptyResult, options)
    return options?.signal?.aborted ? abortedCodexRateLimitResult() : supplemented
  } catch (error) {
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    const message = error instanceof Error ? error.message : 'Unknown error'
    const isNotInstalled = message.includes('ENOENT')
    return codexUnavailable(
      isNotInstalled ? 'Codex CLI not found' : withMacTailscaleDnsHint(message),
      isNotInstalled ? 'unavailable' : 'error'
    )
  }
}
