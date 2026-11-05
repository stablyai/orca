import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { extractCodexAuthError } from '../../shared/codex-auth-errors'
import { codexSpawnEnoent, isSpawnEnoent } from '../codex-cli/windows-only-agent-cli'
import {
  excerptAgentFailureOutput,
  sanitizeAgentFailureDetail
} from '../../shared/source-control/ai/generation/commit-message-agent-output'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { redactString } from '../observability/redactor'
import { mapCodexRpcRateLimits, type RpcRateLimitsResponse } from './codex-rpc-rate-limit-mapper'
import { classifyCodexRpcErrorFailureKind } from './codex-rpc-failure-kind'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'
import { abortedCodexRateLimitResult } from './codex-rate-limit-fetch-result'

const MAX_DIAGNOSTIC_OUTPUT_LENGTH = 100_000

type RpcResponse = {
  id: number
  result?: unknown
  error?: { code: number; message: string }
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

export type CodexRpcRateLimitProbeOptions = {
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
  return readCodexUsageProbe(options, false).then(({ rateLimits }) => rateLimits)
}

export type CodexAccountUsageRead = {
  account?: { type?: string; email?: string; planType?: string } | null
  rateLimits: ProviderRateLimits
  live?: boolean
}

export function readCodexAccountUsageViaRpc(
  options: CodexRpcRateLimitProbeOptions
): Promise<CodexAccountUsageRead> {
  return readCodexUsageProbe(options, true)
}

function readCodexUsageProbe(
  options: CodexRpcRateLimitProbeOptions,
  readAccount: boolean
): Promise<CodexAccountUsageRead> {
  return new Promise((resolve, reject) => {
    const { child, codexCommand, fetchOptions } = options
    let account: CodexAccountUsageRead['account']
    let rpcError: RpcResponse['error']
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
      const finish = (): void => {
        if (readAccount && (rpcError || result.status !== 'ok')) {
          reject(rpcError ?? new Error(result.error ?? 'Codex usage unavailable'))
        } else {
          resolve({ account, rateLimits: result })
        }
      }
      if (settleOptions?.kill) {
        void options.terminate().then(finish, finish)
        return
      }
      finish()
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
      const enoent = isSpawnEnoent(error) ? codexSpawnEnoent(codexCommand) : null
      settle(
        {
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: enoent?.message ?? withMacTailscaleDnsHint(error.message, stderr),
          status: enoent?.missing ? 'unavailable' : 'error'
        },
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
      settle({
        provider: 'codex',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: describeCodexRpcExit(code, signal, stderr),
        status: 'error'
      })
    }

    let accountId: number | null = null
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
            if (readAccount && message.error) {
              rpcError = message.error
              onError(new Error(message.error.message))
              return
            }
            armRpcDeadline(options.rpcTimeoutMs)
            try {
              sendNotification('initialized')
              if (readAccount) {
                accountId = sendRpc('account/read')
              } else {
                rateLimitsId = sendRpc('account/rateLimits/read')
              }
            } catch (error) {
              onError(error instanceof Error ? error : new Error(String(error)))
            }
            continue
          }
          if (accountId !== null && message.id === accountId) {
            if (message.error) {
              rpcError = message.error
              onError(new Error(message.error.message))
              return
            }
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: account/read supplies the Codex account envelope; missing account remains unknown.
            account = (message.result as { account?: CodexAccountUsageRead['account'] })?.account
            if (account?.type === 'apiKey') {
              rpcError = {
                code: -1,
                message: 'API key authentication requires a ChatGPT account for usage'
              }
              onError(new Error(rpcError.message))
              return
            }
            rateLimitsId = sendRpc('account/rateLimits/read')
            continue
          }
          if (rateLimitsId === null || message.id !== rateLimitsId || resolved) {
            continue
          }
          if (message.error) {
            rpcError = message.error
            const failureKind = classifyCodexRpcErrorFailureKind(message.error.message)
            settle(
              {
                provider: 'codex',
                session: null,
                weekly: null,
                updatedAt: Date.now(),
                error: withMacTailscaleDnsHint(message.error.message, stderr),
                status: 'error',
                ...(failureKind ? { usageMetadata: { failureKind } } : {})
              },
              { kill: true }
            )
            return
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared mapper reads only optional fields from the Codex rate-limit reply.
          settle(mapCodexRpcRateLimits(message.result as RpcRateLimitsResponse), { kill: true })
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

// Reauthentication classification and surfaced diagnostics must share the same sanitized text.
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
