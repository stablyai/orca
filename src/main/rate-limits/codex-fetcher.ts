/* eslint-disable max-lines -- Why: keeping both Codex RPC and PTY fallback
paths together in one file makes it easier to audit the protocol/parsing
differences and ensure account-scoped env handling stays identical. */
import type {
  CodexRateLimitResetOutcome,
  ProviderRateLimits,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexAuthExists } from './codex-auth-presence'
import { resolveCodexCommand } from '../codex-cli/command'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { getCmdExePath, getSpawnArgsForWindows } from '../win32-utils'
import { cleanupHiddenRateLimitPty } from './hidden-pty-cleanup'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { extractCodexAuthError, isCodexAuthError } from '../../shared/codex-auth-errors'

const RPC_TIMEOUT_MS = 10_000
const WSL_RPC_TIMEOUT_MS = 25_000
const PTY_TIMEOUT_MS = 15_000
const MAX_DIAGNOSTIC_OUTPUT_LENGTH = 100_000

export type FetchCodexRateLimitsOptions = {
  codexHomePath?: string | null
  allowPtyFallback?: boolean
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

// Why: the Codex app-server wraps rate limit data inside a `rateLimits` key.
// The actual response shape is `{ rateLimits: { primary, secondary, ... } }`.
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

type BackendConsumeRateLimitResetCreditResponse = {
  code?: string
}

type CodexBackendAuthHeaders = {
  headers: Record<string, string>
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function buildWslCodexCommand(
  codexHomePath: string,
  args: string[]
): {
  command: string
  args: string[]
} | null {
  const wslInfo = parseWslUncPath(codexHomePath)
  if (process.platform !== 'win32' || !wslInfo) {
    return null
  }
  const script = [
    `export CODEX_HOME=${shellQuote(wslInfo.linuxPath)}`,
    `exec codex ${args.map(shellQuote).join(' ')}`
  ].join('; ')
  return {
    command: 'wsl.exe',
    args: ['-d', wslInfo.distro, '--', 'bash', '-lc', script]
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

async function getCodexBackendAuthHeaders(
  options?: FetchCodexRateLimitsOptions
): Promise<CodexBackendAuthHeaders | null> {
  const authPath = join(getCodexHomePath(options?.codexHomePath), 'auth.json')
  const auth = JSON.parse(await readFile(authPath, 'utf8')) as CodexAuthFile
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
  const auth = await getCodexBackendAuthHeaders(options)
  if (!auth) {
    return null
  }
  // Why: published Codex 0.140 can read windows through app-server but strips
  // reset-credit metadata that the backend already returns.
  const response = await fetch(
    'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
    auth
  )
  if (!response.ok) {
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
  const auth = await getCodexBackendAuthHeaders(options)
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
      body: JSON.stringify({ redeem_request_id: options.idempotencyKey })
    }
  )
  if (!response.ok) {
    throw new Error(`Codex reset failed: HTTP ${response.status}`)
  }
  const payload = (await response.json()) as BackendConsumeRateLimitResetCreditResponse
  return mapBackendConsumeOutcome(payload.code)
}

function mapRpcWindow(
  raw: RpcRateWindow | undefined,
  expectedWindowMinutes: number
): RateLimitWindow | null {
  if (!raw || typeof raw.usedPercent !== 'number') {
    return null
  }
  let resetDescription: string | null = null
  let resetsAt: number | null = null

  if (raw.resetsAt) {
    // Why: Codex returns resetsAt as Unix seconds, not milliseconds.
    const date = new Date(raw.resetsAt * 1000)
    if (!isNaN(date.getTime())) {
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
    // Why: Codex currently reports remaining minutes in `windowDurationMins`.
    // Orca's UI needs the fixed bucket duration so labels stay "5h" / "wk".
    windowMinutes: expectedWindowMinutes,
    resetsAt,
    resetDescription
  }
}

// ---------------------------------------------------------------------------
// RPC fetch — spawn `codex -s read-only -a untrusted app-server`
// ---------------------------------------------------------------------------

async function fetchViaRpc(options?: FetchCodexRateLimitsOptions): Promise<ProviderRateLimits> {
  return new Promise<ProviderRateLimits>((resolve) => {
    let buffer = ''
    let stderr = ''
    let resolved = false
    let rpcId = 0

    const codexArgs = ['-s', 'read-only', '-a', 'untrusted', 'app-server']
    const wslCodex = options?.codexHomePath
      ? buildWslCodexCommand(options.codexHomePath, codexArgs)
      : null
    // Why: cold WSL process startup plus Codex app-server initialization can
    // exceed the host RPC budget, causing a false "unavailable" on app launch.
    const rpcTimeoutMs = wslCodex ? WSL_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS
    const codexCommand = wslCodex ? 'codex' : resolveCodexCommand()
    // Why: on Windows, resolveCodexCommand() may return a .cmd/.bat file.
    // spawn() cannot execute batch scripts directly without shell:true, but
    // shell:true with an args array triggers DEP0190 (args are concatenated,
    // not escaped). Fix: detect batch scripts and route through cmd.exe /c.
    const { spawnCmd, spawnArgs } = wslCodex
      ? { spawnCmd: wslCodex.command, spawnArgs: wslCodex.args }
      : getSpawnArgsForWindows(codexCommand, codexArgs)
    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Why: the selected Codex rate-limit account must only affect this fetch
      // subprocess. Never mutate process.env globally or other Codex features
      // would inherit the managed account unintentionally.
      // Why windowsHide: this fetch runs periodically in the background;
      // without the flag, cmd.exe /c would flash a console window for each
      // poll on Windows.
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

    // Why: the Codex RPC server follows the JSON-RPC/LSP initialization
    // handshake: client sends `initialize` request, waits for the response,
    // then sends an `initialized` notification. Only after that will the
    // server accept other methods. Skipping the notification causes "Not
    // initialized" errors on subsequent requests.
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
            // Initialize succeeded — send `initialized` notification, then
            // request rate limits.
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

// Why: these patterns match the Codex CLI's /status output format.
// "5h limit" and "Weekly limit" lines contain a percent and optional reset text.
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
        usedPercent: Math.min(100, parseInt(fiveMatch[1], 10)),
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
    : null

  const weekly: RateLimitWindow | null = weeklyMatch
    ? {
        usedPercent: Math.min(100, parseInt(weeklyMatch[1], 10)),
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
  const pty = await import('node-pty')
  const wslCodex = options?.codexHomePath ? buildWslCodexCommand(options.codexHomePath, []) : null
  const codexCommand = wslCodex ? 'codex' : resolveCodexCommand()

  // Why: node-pty cannot spawn .cmd/.bat batch scripts directly on Windows —
  // those need cmd.exe as an interpreter. resolveCodexCommand() may also fall
  // back to bare 'codex' when it can't locate the binary on disk, yet cmd.exe
  // can still find codex.cmd via PATHEXT. Always route through cmd.exe on win32.
  // Why not getSpawnArgsForWindows: the PTY path must route through cmd.exe
  // even for bare 'codex' (not just .cmd/.bat) to let PATHEXT resolution
  // succeed under a minimal Electron PATH. /d matches the rest of the codebase.
  const isWin32 = process.platform === 'win32'
  const spawnFile = wslCodex ? wslCodex.command : isWin32 ? getCmdExePath() : codexCommand
  const spawnArgs = wslCodex ? wslCodex.args : isWin32 ? ['/d', '/c', codexCommand] : []

  return new Promise<ProviderRateLimits>((resolve) => {
    let output = ''
    let resolved = false
    let sentStatus = false
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    const term = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      env: {
        ...(wslCodex ? cloneProcessEnvWithoutCodexHome() : process.env),
        TERM: 'xterm-256color',
        ...(options?.codexHomePath && !wslCodex ? { CODEX_HOME: options.codexHomePath } : {})
      }
    })
    const termDisposables: { dispose: () => void }[] = []

    const timeout = setTimeout(() => {
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
      // Why: this background fallback only needs recent status output for
      // parsing and diagnostics; cap noisy TUI output like the Claude fallback.
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
        // Why: after status text is parseable the TUI may continue streaming
        // chunks; one settle timer is enough to let the panel finish flushing.
        settleTimer = setTimeout(() => {
          settleTimer = null
          if (resolved) {
            return
          }
          resolved = true
          clearTimeout(timeout)
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
        clearTimeout(timeout)
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
  // Why: never spawn the `codex` binary unless the user has signed in. Without
  // auth the RPC/PTY paths can only error, and spawning them shows up as an
  // unexpected background Codex process for users who don't use Codex.
  if (!codexAuthExists(options?.codexHomePath)) {
    return {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Codex not signed in',
      status: 'unavailable'
    }
  }

  // Path A: try RPC first
  try {
    const rpcResult = await fetchViaRpc(options)
    if (rpcResult.status === 'ok' || rpcResult.status === 'unavailable') {
      return await withBackendRateLimitResetCredits(rpcResult, options)
    }
    if (isCodexAuthError(rpcResult.error)) {
      return rpcResult
    }
    if (options?.allowPtyFallback === false) {
      return rpcResult
    }
    // Why: app-server can fail independently of the interactive CLI. Keep the
    // status-bar useful by trying the older /status PTY reader on RPC errors.
  } catch {
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

  // Path B: PTY fallback
  try {
    return await withBackendRateLimitResetCredits(await fetchViaPty(options), options)
  } catch (err) {
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
