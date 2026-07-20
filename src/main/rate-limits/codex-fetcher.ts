/* eslint-disable max-lines -- Why: keep Codex RPC and PTY fallback paths together to audit protocol/parsing differences and shared account-scoped env handling. */
import type {
  CodexRateLimitResetOutcome,
  ProviderRateLimits,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { join } from 'node:path'
import { probeCodexAuthPresence } from './codex-auth-presence'
import { resolveCodexCommand } from '../codex-cli/command'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { getCmdExePath, getSpawnArgsForWindows } from '../win32-utils'
import { cleanupHiddenRateLimitPty, registerHiddenRateLimitPty } from './hidden-pty-cleanup'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { extractCodexAuthError, isCodexAuthError } from '../../shared/codex-auth-errors'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows
} from '../../shared/wsl-login-shell-command'
import {
  getHiddenRateLimitWslCwdSetupCommands,
  resolveHiddenRateLimitPtyCwd
} from './hidden-rate-limit-pty-cwd'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

const RPC_TIMEOUT_MS = 10_000
const WSL_RPC_TIMEOUT_MS = 25_000
const PTY_TIMEOUT_MS = 15_000
const BACKEND_TIMEOUT_MS = 10_000
// Why: redeeming a reset credit is an explicit user action, not a poll — allow more time for a slow backend.
const REDEEM_BACKEND_TIMEOUT_MS = 30_000
const MAX_DIAGNOSTIC_OUTPUT_LENGTH = 100_000

export type FetchCodexRateLimitsOptions = {
  codexHomePath?: string | null
  allowPtyFallback?: boolean
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

type RpcResponse = {
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

type RpcRateWindow = {
  usedPercent?: number
  windowDurationMins?: number
  resetsAt?: number // Unix seconds
}

type RateLimitResetCredits = {
  availableCount: number
  totalEarnedCount?: number
  nextExpiresAt?: number | null
  credits?: {
    status: string
    expiresAt: number | null
    grantedAt: number | null
  }[]
}

type RpcRateLimitsResult = {
  primary?: RpcRateWindow
  secondary?: RpcRateWindow
}

// Why: the Codex app-server wraps rate limit data as { rateLimits: { primary, secondary, ... } }.
type RpcRateLimitsResponse = {
  rateLimits?: RpcRateLimitsResult
  rateLimitResetCredits?: {
    availableCount?: number
    totalEarnedCount?: number
    nextExpiresAt?: number | null
    credits?: {
      status?: string
      expiresAt?: number | string | null
      grantedAt?: number | string | null
    }[]
  } | null
}

type CodexAuthFile = {
  tokens?: {
    access_token?: string
    account_id?: string
  }
}

type BackendRateLimitResetCreditsResponse = {
  available_count?: number
  total_earned_count?: number
  credits?: {
    status?: string
    expires_at?: string | null
    granted_at?: string | null
  }[]
}

type BackendRateLimitWindow = {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
}

type BackendUsageResponse = {
  plan_type?: string
  rate_limit?: {
    primary_window?: BackendRateLimitWindow | null
    secondary_window?: BackendRateLimitWindow | null
  } | null
  rate_limit_reset_credits?: BackendRateLimitResetCreditsResponse | null
}

type BackendConsumeRateLimitResetCreditResponse = {
  code?: string
}

type CodexBackendAuthHeaders = {
  headers: Record<string, string>
}

type BackendAuthReadResult =
  | { content: string; error?: never }
  | { content?: never; error: unknown }

const backendAuthReadByPath = new Map<
  string,
  SharedAuthFilesystemOperation<BackendAuthReadResult>
>()

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildWslCodexCommand(
  codexHomePath: string,
  args: string[],
  options?: { isolateRpcStdio?: boolean }
): {
  command: string
  args: string[]
} | null {
  const wslInfo = parseWslUncPath(codexHomePath)
  if (process.platform !== 'win32' || !wslInfo) {
    return null
  }
  const setupCommands = [
    ...getHiddenRateLimitWslCwdSetupCommands(),
    `export CODEX_HOME=${shellQuote(wslInfo.linuxPath)}`
  ].join(' && ')
  const execSuffix = `${args.map(shellQuote).join(' ')}${
    options?.isolateRpcStdio ? ' <&3 >&4 3<&- 4>&-' : ''
  }`
  // Why: npm/nvm launchers use `#!/usr/bin/env node`; exec'ing them from plain sh loses Node's PATH and pins stale installs.
  const loginShellCommand = buildWslLoginShellCommand(
    [setupCommands, `exec codex ${execSuffix}`].join(' && ')
  )
  // Why: keep the outer sh non-login and hide RPC pipes before shell startup can read input or print banners.
  const command = options?.isolateRpcStdio
    ? ['exec 3<&0', 'exec 4>&1', 'exec </dev/null', 'exec >/dev/null', loginShellCommand].join('\n')
    : loginShellCommand
  return {
    command: 'wsl.exe',
    args: ['-d', wslInfo.distro, '--', 'sh', '-c', escapeWslShCommandForWindows(command)]
  }
}

function cloneProcessEnvWithoutCodexHome(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CODEX_HOME
  return env
}

function buildRpcMessage(id: number, method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`
}

function getCodexHomePath(codexHomePath?: string | null): string {
  return codexHomePath ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

function parseCreditTimestamp(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Why: reset-credit payloads may use Unix seconds or Unix milliseconds.
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const trimmed = value.trim()
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }
  const timestamp = Date.parse(trimmed)
  return Number.isFinite(timestamp) ? timestamp : null
}

function normalizeCreditStatus(status: string | undefined): string {
  return status?.toLowerCase() ?? 'unknown'
}

function abortedCodexRateLimitResult(): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Rate-limit fetch aborted',
    status: 'error'
  }
}

function getNextAvailableCreditExpiry(
  credits: RateLimitResetCredits['credits'] | undefined
): number | null {
  const expiries =
    credits
      ?.filter((credit) => credit.status === 'available')
      .map((credit) => credit.expiresAt)
      .filter((expiresAt): expiresAt is number => typeof expiresAt === 'number')
      .sort((a, b) => a - b) ?? []
  return expiries[0] ?? null
}

function mapRpcRateLimitResetCredits(
  raw: RpcRateLimitsResponse['rateLimitResetCredits']
): RateLimitResetCredits | null | undefined {
  if (!raw) {
    return raw
  }
  if (typeof raw.availableCount !== 'number' || !Number.isFinite(raw.availableCount)) {
    return null
  }
  const credits = raw.credits?.map((credit) => ({
    status: normalizeCreditStatus(credit.status),
    expiresAt: parseCreditTimestamp(credit.expiresAt),
    grantedAt: parseCreditTimestamp(credit.grantedAt)
  }))
  return {
    availableCount: Math.max(0, Math.floor(raw.availableCount)),
    ...(typeof raw.totalEarnedCount === 'number' && Number.isFinite(raw.totalEarnedCount)
      ? { totalEarnedCount: Math.max(0, Math.floor(raw.totalEarnedCount)) }
      : {}),
    nextExpiresAt: parseCreditTimestamp(raw.nextExpiresAt) ?? getNextAvailableCreditExpiry(credits),
    ...(credits ? { credits } : {})
  }
}

function mapBackendRateLimitResetCredits(
  raw: BackendRateLimitResetCreditsResponse | null | undefined
): RateLimitResetCredits | null | undefined {
  if (!raw) {
    return raw
  }
  const credits = raw.credits?.map((credit) => ({
    status: normalizeCreditStatus(credit.status),
    expiresAt: parseCreditTimestamp(credit.expires_at),
    grantedAt: parseCreditTimestamp(credit.granted_at)
  }))
  const availableCount =
    typeof raw.available_count === 'number' && Number.isFinite(raw.available_count)
      ? raw.available_count
      : (credits?.filter((credit) => credit.status === 'available').length ?? null)
  if (availableCount === null) {
    return null
  }
  return {
    availableCount: Math.max(0, Math.floor(availableCount)),
    ...(typeof raw.total_earned_count === 'number' && Number.isFinite(raw.total_earned_count)
      ? { totalEarnedCount: Math.max(0, Math.floor(raw.total_earned_count)) }
      : {}),
    nextExpiresAt: getNextAvailableCreditExpiry(credits),
    ...(credits ? { credits } : {})
  }
}

function createBackendRequestSignal(
  callerSignal?: AbortSignal,
  timeoutMs = BACKEND_TIMEOUT_MS
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal
}

function getBackendAuthRead(
  authPath: string
): SharedAuthFilesystemOperation<BackendAuthReadResult> {
  const existing = backendAuthReadByPath.get(authPath)
  if (existing) {
    return existing
  }
  // Why: Node can't cancel an in-flight UNC read; keep one read per auth path so repeated refreshes don't stack them.
  const read = createAuthFilesystemOperation(authPath, () =>
    readFile(authPath, 'utf8').then(
      (content) => ({ content }),
      (error: unknown) => ({ error })
    )
  )
  backendAuthReadByPath.set(authPath, read)
  const clearRead = (): void => {
    if (backendAuthReadByPath.get(authPath) === read) {
      backendAuthReadByPath.delete(authPath)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

async function readBackendAuth(authPath: string, signal: AbortSignal): Promise<string> {
  const result = await getBackendAuthRead(authPath).wait(signal)
  if ('error' in result) {
    throw result.error
  }
  return result.content
}

async function getCodexBackendAuthHeaders(
  options: FetchCodexRateLimitsOptions | undefined,
  signal: AbortSignal
): Promise<CodexBackendAuthHeaders | null> {
  if (signal.aborted) {
    return null
  }
  const authPath = join(getCodexHomePath(options?.codexHomePath), 'auth.json')
  const auth = JSON.parse(await readBackendAuth(authPath, signal)) as CodexAuthFile
  const accessToken = auth.tokens?.access_token
  if (!accessToken) {
    return null
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop'
  }
  if (auth.tokens?.account_id) {
    headers['ChatGPT-Account-Id'] = auth.tokens.account_id
  }
  return { headers }
}

async function fetchBackendRateLimitResetCredits(
  options?: FetchCodexRateLimitsOptions
): Promise<RateLimitResetCredits | null> {
  if (options?.signal?.aborted) {
    return null
  }
  const signal = createBackendRequestSignal(options?.signal)
  const auth = await getCodexBackendAuthHeaders(options, signal)
  if (!auth) {
    return null
  }
  if (signal.aborted) {
    return null
  }
  // Why: Codex 0.140's app-server strips the reset-credit metadata this backend endpoint still returns.
  const response = await fetch('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', {
    ...auth,
    signal
  })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return null
  }
  const payload = (await response.json()) as BackendRateLimitResetCreditsResponse
  return mapBackendRateLimitResetCredits(payload) ?? null
}

async function withBackendRateLimitResetCredits(
  limits: ProviderRateLimits,
  options?: FetchCodexRateLimitsOptions
): Promise<ProviderRateLimits> {
  if (
    options?.signal?.aborted ||
    limits.provider !== 'codex' ||
    (limits.rateLimitResetCredits?.nextExpiresAt !== undefined &&
      limits.rateLimitResetCredits.nextExpiresAt !== null)
  ) {
    return limits
  }
  try {
    const rateLimitResetCredits = await fetchBackendRateLimitResetCredits(options)
    return rateLimitResetCredits === null ? limits : { ...limits, rateLimitResetCredits }
  } catch {
    return limits
  }
}

function mapBackendConsumeOutcome(code: string | undefined): CodexRateLimitResetOutcome {
  if (code === 'reset') {
    return 'reset'
  }
  if (code === 'nothing_to_reset') {
    return 'nothingToReset'
  }
  if (code === 'no_credit') {
    return 'noCredit'
  }
  if (code === 'already_redeemed') {
    return 'alreadyRedeemed'
  }
  throw new Error(`Unknown Codex reset outcome: ${code ?? 'missing'}`)
}

export async function consumeCodexRateLimitResetCredit(options: {
  codexHomePath?: string | null
  idempotencyKey: string
}): Promise<CodexRateLimitResetOutcome> {
  if (!options.idempotencyKey.trim()) {
    throw new Error('Codex reset idempotency key is required')
  }
  const signal = createBackendRequestSignal(undefined, REDEEM_BACKEND_TIMEOUT_MS)
  const auth = await getCodexBackendAuthHeaders(options, signal)
  if (!auth) {
    throw new Error('Codex not signed in')
  }
  const response = await fetch(
    'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
    {
      method: 'POST',
      headers: {
        ...auth.headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ redeem_request_id: options.idempotencyKey }),
      signal
    }
  )
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    throw new Error(`Codex reset failed: HTTP ${response.status}`)
  }
  const payload = (await response.json()) as BackendConsumeRateLimitResetCreditResponse
  return mapBackendConsumeOutcome(payload.code)
}

function mapRpcWindow(
  raw: RpcRateWindow | undefined,
  expectedWindowMinutes: number
): RateLimitWindow | null {
  if (!raw || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) {
    return null
  }
  let resetDescription: string | null = null
  let resetsAt: number | null = null

  if (typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) && raw.resetsAt > 0) {
    // Why: Codex returns resetsAt as Unix seconds, not milliseconds.
    const date = new Date(raw.resetsAt * 1000)
    if (!Number.isNaN(date.getTime())) {
      resetsAt = date.getTime()
      const now = new Date()
      const isToday = date.toDateString() === now.toDateString()
      resetDescription = isToday
        ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : date.toLocaleDateString(undefined, {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
          })
    }
  }

  return {
    usedPercent: Math.min(100, Math.max(0, raw.usedPercent)),
    // Why: windowDurationMins reports remaining minutes, but the UI needs the fixed bucket duration for "5h"/"wk" labels.
    windowMinutes: expectedWindowMinutes,
    resetsAt,
    resetDescription
  }
}

function mapBackendUsageWindow(
  raw: BackendRateLimitWindow | null | undefined,
  fallbackWindowMinutes: number
): RateLimitWindow | null {
  const limitWindowSeconds = raw?.limit_window_seconds
  // Why: match Codex backend-client's window_minutes_from_seconds — actual bucket duration, rounding partial minutes up.
  const windowMinutes =
    typeof limitWindowSeconds === 'number' &&
    Number.isFinite(limitWindowSeconds) &&
    limitWindowSeconds > 0
      ? Math.ceil(limitWindowSeconds / 60)
      : fallbackWindowMinutes
  return mapRpcWindow(
    raw
      ? {
          usedPercent: raw.used_percent,
          resetsAt: raw.reset_at
        }
      : undefined,
    windowMinutes
  )
}

async function fetchViaBackend(
  options?: FetchCodexRateLimitsOptions
): Promise<ProviderRateLimits | null> {
  const signal = createBackendRequestSignal(options?.signal)
  const auth = await getCodexBackendAuthHeaders(options, signal)
  if (!auth || signal.aborted) {
    return null
  }
  // Why: reuse Codex's own get_rate_limit_status endpoint, avoiding a hidden app-server (and WSL login shell) per refresh.
  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    ...auth,
    signal
  })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return null
  }
  const payload = (await response.json()) as BackendUsageResponse
  // Why: plan_type is required by Codex's RateLimitStatusPayload; reject malformed JSON so the app-server fallback still runs.
  if (typeof payload.plan_type !== 'string') {
    return null
  }
  return {
    provider: 'codex',
    session: mapBackendUsageWindow(payload.rate_limit?.primary_window, 300),
    weekly: mapBackendUsageWindow(payload.rate_limit?.secondary_window, 10080),
    ...(payload.rate_limit_reset_credits !== undefined
      ? {
          rateLimitResetCredits:
            mapBackendRateLimitResetCredits(payload.rate_limit_reset_credits) ?? null
        }
      : {}),
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

// ---------------------------------------------------------------------------
// RPC fetch — spawn `codex -s read-only -a untrusted app-server`
// ---------------------------------------------------------------------------

async function fetchViaRpc(options?: FetchCodexRateLimitsOptions): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  return new Promise<ProviderRateLimits>((resolve) => {
    let buffer = ''
    let stderr = ''
    let resolved = false
    let rpcId = 0

    const codexArgs = ['-s', 'read-only', '-a', 'untrusted', 'app-server']
    const wslCodex = options?.codexHomePath
      ? buildWslCodexCommand(options.codexHomePath, codexArgs, { isolateRpcStdio: true })
      : null
    // Why: cold WSL startup + app-server init can exceed the host RPC budget, causing a false "unavailable" on launch.
    const rpcTimeoutMs = wslCodex ? WSL_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS
    const codexCommand = wslCodex ? 'codex' : resolveCodexCommand()
    // Why: .cmd/.bat launchers can't be spawned directly and shell:true triggers DEP0190 — route them through cmd.exe /c.
    const { spawnCmd, spawnArgs } = wslCodex
      ? { spawnCmd: wslCodex.command, spawnArgs: wslCodex.args }
      : getSpawnArgsForWindows(codexCommand, codexArgs)
    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: resolveHiddenRateLimitPtyCwd(),
      // Why: scope the selected account to this subprocess only; never mutate process.env globally.
      // Why windowsHide: without it, background cmd.exe /c polls flash a console window on Windows.
      windowsHide: true,
      env: {
        ...(wslCodex ? cloneProcessEnvWithoutCodexHome() : process.env),
        ...(options?.codexHomePath && !wslCodex ? { CODEX_HOME: options.codexHomePath } : {})
      }
    })

    let timeout: ReturnType<typeof setTimeout> | null = null

    function cleanupListeners(): void {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      options?.signal?.removeEventListener('abort', onAbort)
      child.stdout.off('data', onStdoutData)
      child.stderr.off('data', onStderrData)
      child.off('error', onError)
      child.off('close', onClose)
    }

    function settle(result: ProviderRateLimits, options?: { kill?: boolean }): void {
      if (resolved) {
        return
      }
      resolved = true
      cleanupListeners()
      if (options?.kill) {
        child.kill()
      }
      resolve(result)
    }

    function onAbort(): void {
      settle(abortedCodexRateLimitResult(), { kill: true })
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    timeout = setTimeout(() => {
      settle(
        {
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: 'RPC timeout',
          status: 'error'
        },
        { kill: true }
      )
    }, rpcTimeoutMs)

    function sendRpc(method: string, params?: unknown): number {
      const id = ++rpcId
      child.stdin.write(buildRpcMessage(id, method, params))
      return id
    }

    // Why: JSON-RPC/LSP handshake — send `initialized` after initialize or the server rejects methods as "Not initialized".
    let rateLimitsId: number | null = null

    const initId = sendRpc('initialize', {
      clientInfo: { name: 'orca', version: '1.0.0' }
    })

    function sendNotification(method: string): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: {} })}\n`)
    }

    function onStdoutData(chunk: Buffer): void {
      buffer += chunk.toString()

      // JSON-RPC messages are newline-delimited
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) {
          continue
        }

        try {
          const msg = JSON.parse(line) as RpcResponse

          // Skip server-initiated notifications (no id field)
          if (msg.id == null) {
            continue
          }

          if (msg.id === initId) {
            // Initialize succeeded — send `initialized`, then request rate limits.
            sendNotification('initialized')
            rateLimitsId = sendRpc('account/rateLimits/read')
            continue
          }

          if (rateLimitsId !== null && msg.id === rateLimitsId) {
            if (resolved) {
              return
            }

            if (msg.error) {
              settle(
                {
                  provider: 'codex',
                  session: null,
                  weekly: null,
                  updatedAt: Date.now(),
                  error: withMacTailscaleDnsHint(msg.error.message, stderr),
                  status: 'error'
                },
                { kill: true }
              )
              return
            }

            const wrapper = msg.result as RpcRateLimitsResponse | undefined
            const result = wrapper?.rateLimits
            const session = mapRpcWindow(result?.primary, 300)
            const weekly = mapRpcWindow(result?.secondary, 10080)
            const rateLimitResetCredits = mapRpcRateLimitResetCredits(
              wrapper?.rateLimitResetCredits
            )

            settle(
              {
                provider: 'codex',
                session,
                weekly,
                ...(rateLimitResetCredits !== undefined ? { rateLimitResetCredits } : {}),
                updatedAt: Date.now(),
                error: null,
                status: 'ok'
              },
              { kill: true }
            )
          }
        } catch {
          // Non-JSON line from the RPC server — ignore
        }
      }
    }

    function onStderrData(chunk: Buffer): void {
      stderr += chunk.toString()
      // Why: this background poll only needs recent failure context for hints.
      if (stderr.length > MAX_DIAGNOSTIC_OUTPUT_LENGTH) {
        stderr = stderr.slice(-MAX_DIAGNOSTIC_OUTPUT_LENGTH)
      }
    }

    function onError(err: Error): void {
      const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT'
      const isBareCommand = codexCommand === 'codex'
      settle({
        provider: 'codex',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: isEnoent
          ? isBareCommand
            ? 'Codex CLI not found'
            : 'Codex CLI found but could not run — Node.js may not be in your PATH'
          : withMacTailscaleDnsHint(err.message, stderr),
        status: isEnoent && isBareCommand ? 'unavailable' : 'error'
      })
    }

    function onClose(): void {
      settle({
        provider: 'codex',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: withMacTailscaleDnsHint('RPC process exited unexpectedly', stderr),
        status: 'error'
      })
    }

    child.stdout.on('data', onStdoutData)
    child.stderr.on('data', onStderrData)
    child.on('error', onError)
    child.on('close', onClose)
  })
}

// ---------------------------------------------------------------------------
// PTY fallback — spawn `codex`, send `/status`, parse rendered output
// ---------------------------------------------------------------------------

// Why: match the Codex CLI /status output ("5h limit"/"Weekly limit" lines with a percent and optional reset text).
const FIVE_HOUR_RE = /5h\s+limit[:\s]*(\d+)%/i
const WEEKLY_RE = /weekly\s+limit[:\s]*(\d+)%/i
const RESET_TEXT_RE = /resets?\s+(?:at\s+|in\s+)?(.+)/i

function parsePtyStatus(output: string): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
} {
  const fiveMatch = FIVE_HOUR_RE.exec(output)
  const weeklyMatch = WEEKLY_RE.exec(output)

  const session: RateLimitWindow | null = fiveMatch
    ? {
        usedPercent: Math.min(100, Number.parseInt(fiveMatch[1], 10)),
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
    : null

  const weekly: RateLimitWindow | null = weeklyMatch
    ? {
        usedPercent: Math.min(100, Number.parseInt(weeklyMatch[1], 10)),
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null
      }
    : null

  // Try to extract reset time from surrounding text
  const resetMatch = RESET_TEXT_RE.exec(output)
  if (resetMatch && session) {
    session.resetDescription = resetMatch[1].trim()
  }

  return { session, weekly }
}

async function fetchViaPty(options?: FetchCodexRateLimitsOptions): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  const pty = await import('node-pty')
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  const wslCodex = options?.codexHomePath ? buildWslCodexCommand(options.codexHomePath, []) : null
  const codexCommand = wslCodex ? 'codex' : resolveCodexCommand()

  // Why: on win32 route through cmd.exe (even bare 'codex') so PATHEXT resolves codex.cmd under a minimal Electron PATH.
  const isWin32 = process.platform === 'win32'
  const spawnFile = wslCodex ? wslCodex.command : isWin32 ? getCmdExePath() : codexCommand
  const spawnArgs = wslCodex ? wslCodex.args : isWin32 ? ['/d', '/c', codexCommand] : []

  return new Promise<ProviderRateLimits>((resolve) => {
    let output = ''
    let resolved = false
    let sentStatus = false
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const term = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: resolveHiddenRateLimitPtyCwd(),
      env: {
        ...(wslCodex ? cloneProcessEnvWithoutCodexHome() : process.env),
        TERM: 'xterm-256color',
        ...(options?.codexHomePath && !wslCodex ? { CODEX_HOME: options.codexHomePath } : {})
      }
    })
    const termDisposables: { dispose: () => void }[] = [registerHiddenRateLimitPty(term)]

    function settleAborted(): void {
      if (resolved) {
        return
      }
      resolved = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
      cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
      resolve(abortedCodexRateLimitResult())
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        settleAborted()
        return
      }
      options.signal.addEventListener('abort', settleAborted, { once: true })
      termDisposables.push({
        dispose: () => options.signal?.removeEventListener('abort', settleAborted)
      })
    }

    timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        if (settleTimer) {
          clearTimeout(settleTimer)
          settleTimer = null
        }
        cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
        resolve({
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: extractCodexAuthError(output) ?? withMacTailscaleDnsHint('PTY timeout', output),
          status: 'error'
        })
      }
    }, PTY_TIMEOUT_MS)

    const onDataDisposable = term.onData((data) => {
      output += data
      // Why: only recent status output is needed; cap noisy TUI output like the Claude fallback.
      if (output.length > MAX_DIAGNOSTIC_OUTPUT_LENGTH) {
        output = output.slice(-MAX_DIAGNOSTIC_OUTPUT_LENGTH)
      }

      // Wait for prompt, then send /status
      if (!sentStatus && />\s*$/.test(data)) {
        sentStatus = true
        term.write('/status\r')
        return
      }

      // Check if we have parseable output
      if (sentStatus && !settleTimer && (FIVE_HOUR_RE.test(output) || WEEKLY_RE.test(output))) {
        // Why: the TUI keeps streaming after status is parseable; one settle timer lets the panel finish flushing.
        settleTimer = setTimeout(() => {
          settleTimer = null
          if (resolved) {
            return
          }
          resolved = true
          if (timeout) {
            clearTimeout(timeout)
            timeout = null
          }
          cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })

          // eslint-disable-next-line no-control-regex
          const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          const { session, weekly } = parsePtyStatus(clean)

          resolve({
            provider: 'codex',
            session,
            weekly,
            updatedAt: Date.now(),
            error:
              session || weekly
                ? null
                : withMacTailscaleDnsHint('Failed to parse CLI output', clean),
            status: session || weekly ? 'ok' : 'error'
          })
        }, 500)
      }
    })
    if (onDataDisposable) {
      termDisposables.push(onDataDisposable)
    }

    const onExitDisposable = term.onExit(() => {
      cleanupHiddenRateLimitPty(term, termDisposables, { kill: false })
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
      if (!resolved) {
        resolved = true
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        // eslint-disable-next-line no-control-regex
        const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        const { session, weekly } = parsePtyStatus(clean)
        resolve({
          provider: 'codex',
          session,
          weekly,
          updatedAt: Date.now(),
          error:
            session || weekly
              ? null
              : (extractCodexAuthError(clean) ??
                withMacTailscaleDnsHint('CLI exited before status was available', clean)),
          status: session || weekly ? 'ok' : 'error'
        })
      }
    })
    if (onExitDisposable) {
      termDisposables.push(onExitDisposable)
    }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchCodexRateLimits(
  options?: FetchCodexRateLimitsOptions
): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  // Why: don't spawn `codex` unless signed in — otherwise non-Codex users see an unexpected background process that can only error.
  const authPresence = await probeCodexAuthPresence(options?.codexHomePath, {
    signal: options?.signal
  })
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  if (authPresence === 'absent') {
    return {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Codex not signed in',
      status: 'unavailable'
    }
  }
  if (authPresence !== 'present') {
    return {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error:
        authPresence === 'timeout'
          ? 'Timed out while checking Codex sign-in status'
          : 'Codex sign-in status is unavailable',
      status: 'error'
    }
  }

  // Path A (WSL): use Codex's backend usage contract so a routine poll skips spawning a login shell to rebuild the CLI env.
  if (options?.codexHomePath && parseWslUncPath(options.codexHomePath)) {
    try {
      const backendResult = await fetchViaBackend(options)
      if (options?.signal?.aborted) {
        return abortedCodexRateLimitResult()
      }
      if (backendResult) {
        const withResetCredits = await withBackendRateLimitResetCredits(backendResult, options)
        return options?.signal?.aborted ? abortedCodexRateLimitResult() : withResetCredits
      }
    } catch {
      if (options?.signal?.aborted) {
        return abortedCodexRateLimitResult()
      }
      // Why: token refresh, network routing, and custom-CA behavior can differ from the host fetch stack; keep CLI paths as fallbacks.
    }
  }

  // Path B: try RPC
  try {
    const rpcResult = await fetchViaRpc(options)
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    if (rpcResult.status === 'ok' || rpcResult.status === 'unavailable') {
      const withResetCredits = await withBackendRateLimitResetCredits(rpcResult, options)
      return options?.signal?.aborted ? abortedCodexRateLimitResult() : withResetCredits
    }
    if (isCodexAuthError(rpcResult.error)) {
      return rpcResult
    }
    if (options?.allowPtyFallback === false) {
      return rpcResult
    }
    // Why: app-server can fail independently of the interactive CLI; fall back to the /status PTY reader on RPC errors.
  } catch {
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    if (options?.allowPtyFallback === false) {
      return {
        provider: 'codex',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'RPC failed',
        status: 'error'
      }
    }
    // RPC failed — fall through to PTY
  }

  // Path C: PTY fallback
  try {
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    const ptyResult = await fetchViaPty(options)
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    const withResetCredits = await withBackendRateLimitResetCredits(ptyResult, options)
    return options?.signal?.aborted ? abortedCodexRateLimitResult() : withResetCredits
  } catch (err) {
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isNotInstalled = message.includes('ENOENT')
    return {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: isNotInstalled ? 'Codex CLI not found' : withMacTailscaleDnsHint(message),
      status: isNotInstalled ? 'unavailable' : 'error'
    }
  }
}
