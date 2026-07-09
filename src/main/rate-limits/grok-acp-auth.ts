import { spawn } from 'node:child_process'
import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'

const ACP_TIMEOUT_MS = 20_000
const ACP_KILL_GRACE_MS = 1500

export type GrokCliAuthResult =
  | { status: 'ok' }
  | { status: 'error' | 'unavailable'; error: string; failureKind: UsageRateLimitFailureKind }

type JsonRpcResponse = {
  id?: unknown
  result?: unknown
  error?: { message?: unknown; code?: unknown }
}

type GrokCliAuthOptions = {
  grokHomePath?: string | null
  signal?: AbortSignal
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function makeJsonRpcRequest(method: string, params: unknown, id: number): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  )
}

function unavailable(error: string, failureKind: UsageRateLimitFailureKind): GrokCliAuthResult {
  return { status: 'unavailable', error, failureKind }
}

function failed(error: string, failureKind: UsageRateLimitFailureKind): GrokCliAuthResult {
  return { status: 'error', error, failureKind }
}

async function hydrateGrokCliPath(): Promise<void> {
  try {
    const hydration = await hydrateShellPath()
    if (hydration.ok) {
      mergePathSegments(hydration.segments)
    }
  } catch {
    // PATH hydration is best-effort; spawn below still reports a structured
    // CLI-unavailable result if the command cannot be resolved.
  }
}

export async function authenticateWithGrokCli(
  options: GrokCliAuthOptions = {}
): Promise<GrokCliAuthResult> {
  // Why: `grok agent stdio` is the documented structured integration path.
  // Calling `authenticate` lets the CLI own OAuth refresh and auth precedence.
  if (options.signal?.aborted) {
    return failed('Grok authentication aborted.', 'network')
  }
  await hydrateGrokCliPath()
  if (options.signal?.aborted) {
    return failed('Grok authentication aborted.', 'network')
  }
  return await new Promise<GrokCliAuthResult>((resolve) => {
    const child = options.grokHomePath
      ? spawn('grok', ['--no-auto-update', 'agent', 'stdio'], {
          stdio: ['pipe', 'pipe', 'ignore'],
          env: {
            ...process.env,
            GROK_HOME: options.grokHomePath
          }
        })
      : spawn('grok', ['--no-auto-update', 'agent', 'stdio'], {
          stdio: ['pipe', 'pipe', 'ignore']
        })
    let settled = false
    let nextId = 1
    let stdoutBuffer = ''
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const pending = new Map<
      number,
      {
        resolve: (value: unknown) => void
        reject: (error: Error) => void
      }
    >()

    const rejectPending = (error: Error): void => {
      for (const entry of pending.values()) {
        entry.reject(error)
      }
      pending.clear()
    }

    const cleanup = (): void => {
      clearTimeout(timer)
      if (killTimer) {
        clearTimeout(killTimer)
        killTimer = null
      }
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout.off('data', onStdoutData)
      child.stdin.off('error', onStdinError)
      child.off('error', onChildError)
      child.off('close', onClose)
    }

    const onAbort = (): void => {
      finish(failed('Grok authentication aborted.', 'network'))
    }

    const terminateChild = (): void => {
      try {
        child.stdin.end()
      } catch {
        // ignore
      }
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      }, ACP_KILL_GRACE_MS)
      if (typeof killTimer.unref === 'function') {
        killTimer.unref()
      }
    }

    const finish = (value: GrokCliAuthResult, options: { terminate?: boolean } = {}): void => {
      if (settled) {
        return
      }
      settled = true
      rejectPending(new Error('error' in value ? value.error : 'Grok authentication finished.'))
      cleanup()
      if (options.terminate !== false) {
        terminateChild()
      }
      resolve(value)
    }

    const request = (method: string, params: unknown): Promise<unknown> => {
      if (settled) {
        return Promise.reject(new Error('Grok CLI authentication already finished.'))
      }
      const id = nextId++
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
        try {
          child.stdin.write(makeJsonRpcRequest(method, params, id), (error?: Error | null) => {
            if (!error) {
              return
            }
            const entry = pending.get(id)
            if (!entry) {
              return
            }
            pending.delete(id)
            entry.reject(error)
          })
        } catch (error) {
          pending.delete(id)
          rejectRequest(error instanceof Error ? error : new Error('Grok ACP stdin write failed.'))
        }
      })
    }

    const timer = setTimeout(() => {
      finish(failed('Timed out authenticating with Grok CLI.', 'cli-unavailable'))
    }, ACP_TIMEOUT_MS)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }

    if (options.signal) {
      if (options.signal.aborted) {
        finish(failed('Grok authentication aborted.', 'network'))
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const onChildError = (error: Error): void => {
      finish(
        isEnoent(error)
          ? unavailable('Grok CLI is not installed.', 'cli-unavailable')
          : failed(error instanceof Error ? error.message : 'Grok CLI failed.', 'unknown')
      )
    }

    const onStdinError = (error: Error): void => {
      finish(failed(error.message || 'Grok ACP stdin failed.', 'cli-unavailable'))
    }

    const onClose = (code: number | null): void => {
      finish(
        failed(
          code === null
            ? 'Grok CLI exited before authentication completed.'
            : `Grok CLI exited before authentication completed (code ${code}).`,
          'cli-unavailable'
        ),
        { terminate: false }
      )
    }

    const onStdoutData = (chunk: Buffer | string): void => {
      stdoutBuffer += chunk.toString()
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n')
        if (newline === -1) {
          break
        }
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (!line) {
          continue
        }
        handleJsonRpcLine(line, pending)
      }
    }

    child.on('error', onChildError)
    child.on('close', onClose)
    child.stdin.on('error', onStdinError)
    child.stdout.on('data', onStdoutData)

    void (async () => {
      try {
        const init = asObject(
          await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
        )
        const authMethods = Array.isArray(init?.authMethods) ? init.authMethods : []
        const hasCachedToken = authMethods.some((method) => asObject(method)?.id === 'cached_token')
        if (!hasCachedToken) {
          finish(unavailable('Not signed in to Grok. Run `grok login`.', 'missing-credentials'))
          return
        }
        try {
          await request('authenticate', { methodId: 'cached_token', _meta: { headless: true } })
        } catch (error) {
          finish(
            failed(
              error instanceof Error ? error.message : 'Grok authentication failed.',
              'stale-token'
            )
          )
          return
        }
        finish({ status: 'ok' })
      } catch (error) {
        finish(
          failed(
            error instanceof Error ? error.message : 'Grok authentication failed.',
            'cli-unavailable'
          )
        )
      }
    })()
  })
}

function handleJsonRpcLine(
  line: string,
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
): void {
  let message: JsonRpcResponse
  try {
    message = JSON.parse(line) as JsonRpcResponse
  } catch {
    return
  }
  if (typeof message.id !== 'number') {
    return
  }
  const entry = pending.get(message.id)
  if (!entry) {
    return
  }
  pending.delete(message.id)
  if (message.error) {
    entry.reject(new Error(String(message.error.message ?? 'Grok ACP request failed')))
  } else {
    entry.resolve(message.result)
  }
}
