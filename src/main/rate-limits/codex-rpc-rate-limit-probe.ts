import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { extractCodexAuthError } from '../../shared/codex-auth-errors'
import {
  excerptAgentFailureOutput,
  sanitizeAgentFailureDetail
} from '../../shared/commit-message-agent-output'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { redactString } from '../observability/redactor'
import {
  classifyCodexRateLimitWindows,
  CODEX_SESSION_WINDOW_MINUTES,
  CODEX_WEEKLY_WINDOW_MINUTES,
  isReadableCodexRateLimitWindowsSnapshot,
  type CodexRateLimitWindowsSnapshot
} from './codex-rate-limit-window-classification'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'
import {
  abortedCodexRateLimitResult,
  failedCodexRateLimitReading
} from './codex-rate-limit-fetch-result'
import { mapCodexRateLimitWindow } from './codex-rate-limit-window-mapper'
import {
  mapRpcRateLimitResetCredits,
  type RpcRateLimitResetCredits
} from './codex-reset-credit-client'

const MAX_DIAGNOSTIC_OUTPUT_LENGTH = 100_000

type RpcResponse = {
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

type RpcRateLimitsResponse = {
  rateLimits?: CodexRateLimitWindowsSnapshot | null
  rateLimitResetCredits?: RpcRateLimitResetCredits
}

// Why: `result` crosses the app-server boundary as parsed JSON, so its shape is
// a claim, not a fact. Only a plain object can carry the wrapper's fields; each
// field inside is validated separately by its own mapper.
function readRpcRateLimitsResult(result: unknown): RpcRateLimitsResponse | null {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !isReadableCodexRateLimitWindowsSnapshot((result as RpcRateLimitsResponse).rateLimits)
  ) {
    return null
  }
  return result as RpcRateLimitsResponse
}

type RpcDataStream = {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  off(event: 'data', listener: (chunk: Buffer) => void): unknown
}

type RpcInputStream = {
  write(data: string): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
}

type CodexRpcCloseListener = (code: number | null, signal: NodeJS.Signals | null) => void

export type CodexRpcRateLimitChild = {
  stdin: RpcInputStream
  stdout: RpcDataStream
  stderr: RpcDataStream
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: CodexRpcCloseListener): unknown
  once(event: 'close', listener: CodexRpcCloseListener): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'close', listener: CodexRpcCloseListener): unknown
}

type CodexRpcRateLimitProbeOptions = {
  child: CodexRpcRateLimitChild
  codexCommand: string
  initTimeoutMs: number
  rpcTimeoutMs: number
  fetchOptions?: CodexRateLimitFetchOptions
  terminate: () => Promise<void>
}

function buildRpcMessage(id: number, method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`
}

export function readCodexRateLimitsViaRpc(
  options: CodexRpcRateLimitProbeOptions
): Promise<ProviderRateLimits> {
  return new Promise<ProviderRateLimits>((resolve) => {
    const { child, codexCommand, fetchOptions } = options
    let buffer = ''
    let stderr = ''
    let resolved = false
    let rpcId = 0
    let timeout: ReturnType<typeof setTimeout> | null = null

    function cleanupListeners(): void {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      fetchOptions?.signal?.removeEventListener('abort', onAbort)
      child.stdout.off('data', onStdoutData)
      child.stderr.off('data', onStderrData)
      child.off('error', onError)
      child.off('close', onClose)
    }

    function settle(result: ProviderRateLimits, settleOptions?: { kill?: boolean }): void {
      if (resolved) {
        return
      }
      resolved = true
      cleanupListeners()
      if (settleOptions?.kill) {
        void options.terminate().then(
          () => resolve(result),
          () => resolve(result)
        )
        return
      }
      resolve(result)
    }

    function onAbort(): void {
      settle(abortedCodexRateLimitResult(), { kill: true })
    }

    if (fetchOptions?.signal) {
      if (fetchOptions.signal.aborted) {
        onAbort()
        return
      }
      fetchOptions.signal.addEventListener('abort', onAbort, { once: true })
    }

    function armRpcDeadline(deadlineMs: number): void {
      if (timeout) {
        clearTimeout(timeout)
      }
      timeout = setTimeout(() => {
        settle(failedCodexRateLimitReading('RPC timeout'), { kill: true })
      }, deadlineMs)
    }
    armRpcDeadline(options.initTimeoutMs)

    function sendRpc(method: string, params?: unknown): number {
      const id = ++rpcId
      child.stdin.write(buildRpcMessage(id, method, params))
      return id
    }

    function sendNotification(method: string): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: {} })}\n`)
    }

    function onStderrData(chunk: Buffer): void {
      stderr += chunk.toString()
      if (stderr.length > MAX_DIAGNOSTIC_OUTPUT_LENGTH) {
        stderr = stderr.slice(-MAX_DIAGNOSTIC_OUTPUT_LENGTH)
      }
    }

    function onError(error: Error): void {
      const isEnoent = (error as NodeJS.ErrnoException).code === 'ENOENT'
      const isBareCommand = codexCommand === 'codex'
      settle(
        failedCodexRateLimitReading(
          isEnoent
            ? isBareCommand
              ? 'Codex CLI not found'
              : 'Codex CLI found but could not run — Node.js may not be in your PATH'
            : withMacTailscaleDnsHint(error.message, stderr),
          isEnoent && isBareCommand ? 'unavailable' : 'error'
        ),
        { kill: true }
      )
    }

    function onStdinError(error: Error): void {
      onError(error)
    }

    function detachStdinErrorListener(): void {
      child.stdin.off('error', onStdinError)
    }

    function onClose(code: number | null, signal: NodeJS.Signals | null): void {
      settle(failedCodexRateLimitReading(describeCodexRpcExit(code, signal, stderr)))
    }

    let rateLimitsId: number | null = null
    let initId: number

    function onStdoutData(chunk: Buffer): void {
      buffer += chunk.toString()
      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) {
          continue
        }
        try {
          const message = JSON.parse(line) as RpcResponse
          if (message.id == null) {
            continue
          }
          if (message.id === initId) {
            armRpcDeadline(options.rpcTimeoutMs)
            try {
              sendNotification('initialized')
              rateLimitsId = sendRpc('account/rateLimits/read')
            } catch (error) {
              onError(error instanceof Error ? error : new Error(String(error)))
            }
            continue
          }
          if (rateLimitsId === null || message.id !== rateLimitsId || resolved) {
            continue
          }
          if (message.error) {
            settle(
              failedCodexRateLimitReading(withMacTailscaleDnsHint(message.error.message, stderr)),
              { kill: true }
            )
            return
          }
          const wrapper = readRpcRateLimitsResult(message.result)
          if (!wrapper) {
            // Why: a response carrying neither an error nor a readable result is
            // one Orca could not understand. Classifying it anyway would settle
            // two null windows as a successful reading, and the stale policy
            // would write that over the account's last real usage (STA-3445).
            settle(failedCodexRateLimitReading('Codex returned an unreadable usage response'), {
              kill: true
            })
            return
          }
          const classified = classifyCodexRateLimitWindows(wrapper.rateLimits)
          if (!classified.session && !classified.weekly) {
            // Why (STA-3445): the gate above rejects a window Orca cannot read, but a response
            // claiming no window at all lands on the same two nulls -- and the stale policy
            // cannot tell those apart, so it writes both over the last real usage. Apply the
            // rule the PTY probe already uses: no window is not a successful reading.
            settle(failedCodexRateLimitReading('Codex returned no readable usage windows'), {
              kill: true
            })
            return
          }
          const credits = mapRpcRateLimitResetCredits(wrapper.rateLimitResetCredits)
          settle(
            {
              provider: 'codex',
              session: mapCodexRateLimitWindow(classified.session, CODEX_SESSION_WINDOW_MINUTES),
              weekly: mapCodexRateLimitWindow(classified.weekly, CODEX_WEEKLY_WINDOW_MINUTES),
              ...(credits !== undefined ? { rateLimitResetCredits: credits } : {}),
              updatedAt: Date.now(),
              error: null,
              status: 'ok'
            },
            { kill: true }
          )
        } catch {
          // Non-JSON output from the RPC server is not part of the protocol stream.
        }
      }
    }

    child.stdin.on('error', onStdinError)
    child.stdout.on('data', onStdoutData)
    child.stderr.on('data', onStderrData)
    child.on('error', onError)
    child.once('close', detachStdinErrorListener)
    child.on('close', onClose)

    try {
      initId = sendRpc('initialize', { clientInfo: { name: 'orca', version: '1.0.0' } })
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

// Why: surfaced text drives re-auth classification, so diagnosis and classification must use the same sanitized value.
function describeCodexRpcExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string
): string {
  if (extractCodexAuthError(stderr)) {
    // Fixed copy cannot leak paths/tokens and is exactly what the renderer classifies.
    return 'Your ChatGPT session could not be refreshed. Please sign in again.'
  }
  const reason =
    code !== null ? `exit code ${code}` : signal ? `signal ${signal}` : 'no exit status'
  const detail = sanitizeAgentFailureDetail(
    redactString(excerptAgentFailureOutput('', stderr) ?? '')
  )
  return withMacTailscaleDnsHint(
    detail
      ? `Codex RPC process exited (${reason}): ${detail}`
      : `Codex RPC process exited (${reason})`,
    stderr
  )
}
