import type { CodexRateLimitResetOutcome, ProviderRateLimits } from '../../shared/rate-limit-types'
import { isCodexAuthError } from '../../shared/codex-auth-errors'
import { buildWslExecArgs, buildWslLoginShellCommand } from '../../shared/wsl-login-shell-command'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
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
import { spawnProcess } from '@orca/process-host'
import { probeCodexAuthPresence } from './codex-auth-presence'
import {
  fetchCodexRateLimitsViaBackend,
  supplementCodexSessionWindow
} from './codex-backend-usage-client'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'
import { abortedCodexRateLimitResult } from './codex-rate-limit-fetch-result'
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
  args: string[]
): { command: string; args: string[] } | null {
  const wslInfo = parseWslUncPath(codexHomePath)
  if (process.platform !== 'win32' || !wslInfo) {
    return null
  }
  const setupCommands = [
    ...getHiddenRateLimitWslCwdSetupCommands(),
    `export CODEX_HOME=${quoteHiddenRateLimitShellValue(wslInfo.linuxPath)}`
  ].join(' && ')
  const execSuffix = `${args.map(quoteHiddenRateLimitShellValue).join(' ')} <&3 >&4 3<&- 4>&-`
  const loginShellCommand = buildWslLoginShellCommand(
    [setupCommands, `exec codex ${execSuffix}`].join(' && ')
  )
  const command = [
    'exec 3<&0',
    'exec 4>&1',
    'exec </dev/null',
    'exec >/dev/null',
    loginShellCommand
  ].join('\n')
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
  const codexArgs = [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS]
  const wslCodex = options?.codexHomePath
    ? buildWslCodexCommand(options.codexHomePath, codexArgs)
    : null
  const codexCommand = wslCodex ? 'codex' : resolveCodexCommand()
  // Why the bare CLI: spawnProcess resolves an npm `codex.cmd` shim past cmd.exe itself.
  const child = spawnProcess({
    program: wslCodex ? wslCodex.command : codexCommand,
    args: wslCodex ? wslCodex.args : codexArgs,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: resolveHiddenRateLimitPtyCwd(),
    env: withCliRuntimeOnPath(codexCommand, {
      ...(wslCodex ? processEnvWithoutCodexHome() : process.env),
      ...(options?.codexHomePath && !wslCodex ? { CODEX_HOME: options.codexHomePath } : {})
    })
  })
  return readCodexRateLimitsViaRpc({
    child: child as CodexRpcRateLimitChild,
    codexCommand,
    initTimeoutMs: wslCodex ? WSL_RPC_INIT_TIMEOUT_MS : RPC_INIT_TIMEOUT_MS,
    rpcTimeoutMs: wslCodex ? WSL_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS,
    fetchOptions: options,
    terminate: () => terminateCodexProbeChild(child)
  })
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

async function fetchBackendUsage(
  options: CodexRateLimitFetchOptions | undefined
): Promise<ProviderRateLimits | null> {
  try {
    const result = await fetchCodexRateLimitsViaBackend(fetchCodexUsage, options)
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    return result
      ? supplementCodexRateLimitResetCredits(result, fetchCodexResetCredits, options)
      : null
  } catch {
    return options?.signal?.aborted ? abortedCodexRateLimitResult() : null
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

  const isWslHome = Boolean(options?.codexHomePath && parseWslUncPath(options.codexHomePath))
  if (isWslHome) {
    const backendResult = await fetchBackendUsage(options)
    if (backendResult) {
      return options?.signal?.aborted ? abortedCodexRateLimitResult() : backendResult
    }
  }

  if (options?.codexHomePath && isCodexStateDbBackfillPending(options.codexHomePath)) {
    void startCodexStateDbBackfillRecoveryInBackground(options.codexHomePath)
    return codexUnavailable(
      'Codex is rebuilding its session index; usage will refresh when recovery finishes',
      'error'
    )
  }

  let rpcFailure: ProviderRateLimits
  try {
    const rpcResult = await withCodexHomeProcessLock(
      resolveCodexHomeProcessLockKey(options?.codexHomePath),
      () => fetchViaRpc(options)
    )
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    if (rpcResult.status === 'ok' || rpcResult.status === 'unavailable') {
      const supplemented = await supplementBackendMetadata(rpcResult, options)
      return options?.signal?.aborted ? abortedCodexRateLimitResult() : supplemented
    }
    if (isCodexAuthError(rpcResult.error)) {
      return rpcResult
    }
    rpcFailure = rpcResult
  } catch {
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    rpcFailure = codexUnavailable('RPC failed', 'error')
  }

  if (isWslHome) {
    return rpcFailure
  }
  // Why: read usage over HTTP, never by driving the interactive Codex TUI — keystrokes sent there can accept startup dialogs such as "Update now" (#17415).
  const backendResult = await fetchBackendUsage(options)
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  return backendResult ?? rpcFailure
}
