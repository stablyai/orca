import { BrowserError } from '../browser/cdp-bridge'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import type { RpcContext, RpcMethod } from './rpc/core'

export type BrowserCommandForwardResult = { handled: boolean; result?: unknown }

const BROWSER_FORWARD_DEFAULT_TIMEOUT_MS = 30_000
const BROWSER_FORWARD_GRACE_MS = 10_000

// Why: target-miss codes mean "the local CDP bridge has no such tab" — only
// then does the command plausibly belong to a remote-hosted tab on the
// worktree's owning environment. Other failures must surface as-is.
const BROWSER_FORWARDABLE_CODES = new Set([
  'browser_no_tab',
  'browser_tab_not_found',
  'selector_not_found'
])

export function isForwardableBrowserError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') {
    return BROWSER_FORWARDABLE_CODES.has(code)
  }
  return BROWSER_FORWARDABLE_CODES.has(error.message)
}

function browserForwardTimeoutMs(params: unknown): number {
  const timeoutMs = (params as { timeoutMs?: unknown } | null | undefined)?.timeoutMs
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs + BROWSER_FORWARD_GRACE_MS
  }
  const waitTimeout = (params as { timeout?: unknown } | null | undefined)?.timeout
  if (typeof waitTimeout === 'number' && Number.isFinite(waitTimeout) && waitTimeout > 0) {
    return Math.max(BROWSER_FORWARD_DEFAULT_TIMEOUT_MS, waitTimeout + BROWSER_FORWARD_GRACE_MS)
  }
  return BROWSER_FORWARD_DEFAULT_TIMEOUT_MS
}

// Why: desktop CDP only sees local webviews. Retry target-misses against the
// worktree's owning environment so CLI/agent commands can drive the same
// remote-hosted tabs the UI already creates.
export async function forwardBrowserCommandToOwningEnvironment(args: {
  environmentId: string | null | undefined
  userDataPath: string
  method: string
  params: unknown
  timeoutMs: number
}): Promise<BrowserCommandForwardResult> {
  const environmentId = args.environmentId?.trim()
  if (!environmentId) {
    return { handled: false }
  }
  const response = await callRuntimeEnvironment(
    args.userDataPath,
    environmentId,
    args.method,
    args.params,
    args.timeoutMs
  )
  if (response.ok === false) {
    throw new BrowserError(response.error.code, response.error.message)
  }
  return { handled: true, result: response.result }
}

export function withBrowserEnvironmentForwarding(
  methods: readonly RpcMethod[],
  forward: (
    method: string,
    params: unknown,
    timeoutMs: number,
    ctx: RpcContext
  ) => Promise<BrowserCommandForwardResult>
): RpcMethod[] {
  return methods.map((method) => ({
    ...method,
    handler: async (params: unknown, ctx: RpcContext) => {
      try {
        return await method.handler(params, ctx)
      } catch (error) {
        if (!isForwardableBrowserError(error)) {
          throw error
        }
        const forwarded = await forward(method.name, params, browserForwardTimeoutMs(params), ctx)
        if (!forwarded.handled) {
          throw error
        }
        return forwarded.result
      }
    }
  }))
}
