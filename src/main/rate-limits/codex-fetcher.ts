/* eslint-disable max-lines -- Why: keeping both Codex RPC and PTY fallback
paths together in one file makes it easier to audit the protocol/parsing
differences and ensure account-scoped env handling stays identical. */
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { spawn } from 'node:child_process'
import { resolveCodexCommand } from '../codex-cli/command'

const RPC_TIMEOUT_MS = 10_000
const PTY_TIMEOUT_MS = 15_000

export type FetchCodexRateLimitsOptions = {
  codexHomePath?: string | null
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

type RpcRateLimitsResult = {
  primary?: RpcRateWindow
  secondary?: RpcRateWindow
}

// Why: the Codex app-server wraps rate limit data inside a `rateLimits` key.
// The actual response shape is `{ rateLimits: { primary, secondary, ... } }`.
type RpcRateLimitsResponse = {
  rateLimits?: RpcRateLimitsResult
}

function buildRpcMessage(id: number, method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`
}

function mapRpcWindow(raw: RpcRateWindow | undefined): RateLimitWindow | null {
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
    windowMinutes: raw.windowDurationMins ?? 300,
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
    let resolved = false
    let rpcId = 0

    const child = spawn(
      resolveCodexCommand(),
      ['-s', 'read-only', '-a', 'untrusted', 'app-server'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Why: on Windows, resolveCodexCommand() may return a .cmd/.bat file
        // (e.g. codex.cmd from npm). Node's child_process.spawn cannot execute
        // batch scripts directly — it needs cmd.exe as an intermediary. Setting
        // shell: true on win32 avoids the EINVAL error this would otherwise cause.
        shell: process.platform === 'win32',
        // Why: the selected Codex rate-limit account must only affect this fetch
        // subprocess. Never mutate process.env globally or other Codex features
        // would inherit the managed account unintentionally.
        env: {
          ...process.env,
          ...(options?.codexHomePath ? { CODEX_HOME: options.codexHomePath } : {})
        }
      }
    )

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        child.kill()
        resolve({
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: 'RPC timeout',
          status: 'error'
        })
      }
    }, RPC_TIMEOUT_MS)

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

    child.stdout.on('data', (chunk: Buffer) => {
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
            resolved = true
            clearTimeout(timeout)
            child.kill()

            if (msg.error) {
              resolve({
                provider: 'codex',
                session: null,
                weekly: null,
                updatedAt: Date.now(),
                error: msg.error.message,
                status: 'error'
              })
              return
            }

            const wrapper = msg.result as RpcRateLimitsResponse | undefined
            const result = wrapper?.rateLimits
            const session = mapRpcWindow(result?.primary)
            const weekly = mapRpcWindow(result?.secondary)

            resolve({
              provider: 'codex',
              session,
              weekly,
              updatedAt: Date.now(),
              error: null,
              status: 'ok'
            })
          }
        } catch {
          // Non-JSON line from the RPC server — ignore
        }
      }
    })

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        const isNotInstalled = (err as NodeJS.ErrnoException).code === 'ENOENT'
        resolve({
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: isNotInstalled ? 'Codex CLI not found' : err.message,
          status: isNotInstalled ? 'unavailable' : 'error'
        })
      }
    })

    child.on('close', () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        resolve({
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: 'RPC process exited unexpectedly',
          status: 'error'
        })
      }
    })
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
  const codexCommand = resolveCodexCommand()

  // Why: node-pty cannot spawn .cmd/.bat batch scripts directly on Windows —
  // those need cmd.exe as an interpreter. resolveCodexCommand() may also fall
  // back to bare 'codex' when it can't locate the binary on disk, yet cmd.exe
  // can still find codex.cmd via PATHEXT. Always route through cmd.exe on win32.
  const isWin32 = process.platform === 'win32'
  const spawnFile = isWin32 ? 'cmd.exe' : codexCommand
  const spawnArgs = isWin32 ? ['/c', codexCommand] : []

  return new Promise<ProviderRateLimits>((resolve) => {
    let output = ''
    let resolved = false
    let sentStatus = false

    const term = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        ...(options?.codexHomePath ? { CODEX_HOME: options.codexHomePath } : {})
      }
    })

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        term.kill()
        resolve({
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: 'PTY timeout',
          status: 'error'
        })
      }
    }, PTY_TIMEOUT_MS)

    term.onData((data) => {
      output += data

      // Wait for prompt, then send /status
      if (!sentStatus && />\s*$/.test(data)) {
        sentStatus = true
        term.write('/status\r')
        return
      }

      // Check if we have parseable output
      if (sentStatus && (FIVE_HOUR_RE.test(output) || WEEKLY_RE.test(output))) {
        setTimeout(() => {
          if (resolved) {
            return
          }
          resolved = true
          clearTimeout(timeout)
          term.kill()

          // eslint-disable-next-line no-control-regex
          const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          const { session, weekly } = parsePtyStatus(clean)

          resolve({
            provider: 'codex',
            session,
            weekly,
            updatedAt: Date.now(),
            error: session || weekly ? null : 'Failed to parse CLI output',
            status: session || weekly ? 'ok' : 'error'
          })
        }, 500)
      }
    })

    term.onExit(() => {
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
          error: session || weekly ? null : 'CLI exited before status was available',
          status: session || weekly ? 'ok' : 'error'
        })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchCodexRateLimits(
  options?: FetchCodexRateLimitsOptions
): Promise<ProviderRateLimits> {
  // Path A: try RPC first
  try {
    return await fetchViaRpc(options)
  } catch {
    // RPC failed — fall through to PTY
  }

  // Path B: PTY fallback
  try {
    return await fetchViaPty(options)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isNotInstalled = message.includes('ENOENT')
    return {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: isNotInstalled ? 'Codex CLI not found' : message,
      status: isNotInstalled ? 'unavailable' : 'error'
    }
  }
}
