import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { RpcStreamSubscribeOptions } from '../transport/rpc-client-stream-registry'
import type { RpcResponse } from '../transport/types'
import type { HostSessionBrowserOperations } from '../session/host-session-browser-operations'

export type MobileBrowserRpcClient = Pick<RpcClient, 'sendRequest' | 'subscribe'>

type BrowserParams = Record<string, unknown>

function targetFromParams(params: BrowserParams) {
  const worktree = typeof params.worktree === 'string' ? params.worktree : ''
  const pageId = typeof params.page === 'string' ? params.page : ''
  const workspaceId = worktree.startsWith('id:') ? worktree.slice(3) : worktree
  if (!workspaceId || !pageId) {
    throw new Error('Browser target is unavailable')
  }
  return { workspaceId, pageId }
}

function ok(result: unknown = null): RpcResponse {
  return {
    id: 'mobile-browser-adapter',
    ok: true,
    result,
    _meta: { runtimeId: 'mobile-browser-adapter' }
  }
}

function failure(error: unknown): RpcResponse {
  return {
    ok: false,
    error: {
      code: 'browser_command_failed',
      message: error instanceof Error ? error.message : 'Browser command failed'
    },
    id: 'mobile-browser-adapter',
    _meta: { runtimeId: 'mobile-browser-adapter' }
  }
}

export function createMobileBrowserRpcClient(
  operations: HostSessionBrowserOperations
): MobileBrowserRpcClient {
  const lastPointerByPage = new Map<string, { x: number; y: number }>()

  async function sendRequest(
    method: string,
    rawParams: unknown = {},
    _options?: SendRequestOptions
  ): Promise<RpcResponse> {
    const params = (rawParams ?? {}) as BrowserParams
    try {
      const target = targetFromParams(params)
      const pageKey = `${target.workspaceId}:${target.pageId}`
      switch (method) {
        case 'browser.goto':
          return ok(await operations.navigate(target, String(params.url ?? '')))
        case 'browser.back':
          await operations.back(target)
          return ok()
        case 'browser.forward':
          await operations.forward(target)
          return ok()
        case 'browser.reload':
          await operations.reload(target)
          return ok()
        case 'browser.keyboardInsertText':
          await operations.insertText(target, String(params.text ?? ''))
          return ok()
        case 'browser.keypress':
          await operations.keypress(target, params.key as 'Enter' | 'Backspace' | 'Tab' | 'Escape')
          return ok()
        case 'browser.dialogAccept':
          await operations.dialog(target, 'accept')
          return ok()
        case 'browser.dialogDismiss':
          await operations.dialog(target, 'dismiss')
          return ok()
        case 'browser.mouseMove':
          lastPointerByPage.set(pageKey, { x: Number(params.x) || 0, y: Number(params.y) || 0 })
          return ok()
        case 'browser.mouseWheel': {
          const point = lastPointerByPage.get(pageKey) ?? { x: 0, y: 0 }
          await operations.scroll(target, point, {
            dx: Number(params.dx) || 0,
            dy: Number(params.dy) || 0
          })
          return ok()
        }
        case 'browser.mouseClick':
          await operations.click(
            target,
            { x: Number(params.x) || 0, y: Number(params.y) || 0 },
            params.button === 'right' ? 'right' : 'left',
            Array.isArray(params.modifiers) ? params.modifiers : [],
            typeof params.radius === 'number' ? params.radius : undefined
          )
          // Preserve the legacy hook's success sentinel so it does not issue
          // a second move/down/up sequence after an atomic click.
          return ok({ clicked: true })
        case 'browser.mouseDown':
        case 'browser.mouseUp':
          return ok()
        default:
          throw new Error(`Unsupported browser command: ${method}`)
      }
    } catch (error) {
      return failure(error)
    }
  }

  function subscribe(
    method: string,
    rawParams: unknown,
    onData: (result: unknown) => void,
    options?: RpcStreamSubscribeOptions
  ): () => void {
    if (method !== 'browser.screencast') {
      onData({ type: 'error', message: `Unsupported browser subscription: ${method}` })
      return () => undefined
    }
    const params = (rawParams ?? {}) as BrowserParams
    const target = targetFromParams(params)
    const { worktree: _worktree, page: _page, ...request } = params
    return operations.subscribe(target, request as never, {
      onEvent: (event) => onData(event),
      onFrame: (frame) => options?.onBinaryFrame?.(frame),
      onError: (error) => onData({ type: 'error', message: error.message })
    })
  }

  return { sendRequest, subscribe }
}
