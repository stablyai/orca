import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import type {
  HostSessionBrowserEvent,
  HostSessionBrowserOperations,
  HostSessionBrowserTarget
} from './host-session-browser-operations'

export function nativeHostSessionBrowserOperations(
  client: RpcClient
): HostSessionBrowserOperations {
  return {
    subscribe(target, request, listener) {
      try {
        return client.subscribe(
          'browser.screencast',
          { ...nativeTarget(target), ...request },
          (event) => {
            const presented = nativeBrowserEvent(event)
            if (presented) {
              listener.onEvent(presented)
            }
          },
          { onBinaryFrame: listener.onFrame }
        )
      } catch (error) {
        listener.onError(browserOperationError(error))
        return () => {}
      }
    },
    async navigate(target, url) {
      const result = await requestResult(
        client,
        'browser.goto',
        { ...nativeTarget(target), url },
        30_000
      )
      if (!isRecord(result) || typeof result.url !== 'string') {
        throw new Error('Browser navigation failed')
      }
      return { url: result.url }
    },
    async scroll(target, point, delta) {
      await requestResult(client, 'browser.mouseMove', { ...nativeTarget(target), ...point }, 5_000)
      await requestResult(
        client,
        'browser.mouseWheel',
        { ...nativeTarget(target), ...delta },
        5_000
      )
    },
    async click(target, point, button, modifiers, radius) {
      const click = await client.sendRequest(
        'browser.mouseClick',
        {
          ...nativeTarget(target),
          ...point,
          button,
          modifiers,
          ...(radius === undefined ? {} : { radius })
        },
        { timeoutMs: 5_000 }
      )
      if (click.ok || modifiers.length > 0) {
        return
      }
      await requestResult(client, 'browser.mouseMove', { ...nativeTarget(target), ...point }, 5_000)
      await requestResult(client, 'browser.mouseDown', { ...nativeTarget(target), button }, 5_000)
      await requestResult(client, 'browser.mouseUp', { ...nativeTarget(target), button }, 5_000)
    },
    async insertText(target, text) {
      await requestResult(
        client,
        'browser.keyboardInsertText',
        { ...nativeTarget(target), text },
        5_000
      )
    },
    async keypress(target, key) {
      await requestResult(client, 'browser.keypress', { ...nativeTarget(target), key }, 5_000)
    },
    async dialog(target, action) {
      await requestResult(
        client,
        action === 'accept' ? 'browser.dialogAccept' : 'browser.dialogDismiss',
        nativeTarget(target),
        5_000
      )
    },
    async back(target) {
      await requestResult(client, 'browser.back', nativeTarget(target))
    },
    async forward(target) {
      await requestResult(client, 'browser.forward', nativeTarget(target))
    },
    async reload(target) {
      await requestResult(client, 'browser.reload', nativeTarget(target))
    }
  }
}

function nativeTarget(target: HostSessionBrowserTarget): { worktree: string; page: string } {
  return { worktree: `id:${target.workspaceId}`, page: target.pageId }
}

async function requestResult(
  client: RpcClient,
  method: string,
  payload: unknown,
  timeoutMs = 15_000
): Promise<unknown> {
  const response = await client.sendRequest(method, payload, { timeoutMs })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return (response as RpcSuccess).result
}

function nativeBrowserEvent(value: unknown): HostSessionBrowserEvent | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.type === 'ready') {
    const tab = isRecord(value.tab) ? value.tab : {}
    return {
      type: 'ready',
      tab: {
        url: typeof tab.url === 'string' ? tab.url : 'about:blank',
        title: typeof tab.title === 'string' ? tab.title : '',
        canGoBack: tab.canGoBack === true,
        canGoForward: tab.canGoForward === true
      }
    }
  }
  if (value.type === 'navigation') {
    const tab = isRecord(value.tab) ? value.tab : {}
    return {
      type: 'navigation',
      tab: {
        url: typeof tab.url === 'string' ? tab.url : 'about:blank',
        title: typeof tab.title === 'string' ? tab.title : '',
        canGoBack: tab.canGoBack === true,
        canGoForward: tab.canGoForward === true
      }
    }
  }
  if (value.type === 'end' || value.type === 'dialogClosed') {
    return { type: value.type }
  }
  if (value.type === 'dialog') {
    return {
      type: 'dialog',
      dialogType: typeof value.dialogType === 'string' ? value.dialogType : 'alert',
      message: typeof value.message === 'string' ? value.message : 'Browser dialog'
    }
  }
  if (value.type === 'error') {
    const nested = isRecord(value.error) ? value.error : {}
    return {
      type: 'error',
      message:
        typeof value.message === 'string'
          ? value.message
          : typeof nested.message === 'string'
            ? nested.message
            : 'Browser stream failed.'
    }
  }
  return null
}

function browserOperationError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Browser command failed')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
