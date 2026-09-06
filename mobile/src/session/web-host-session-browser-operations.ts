import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { BrowserPointerModifier } from '../browser/MobileBrowserPointerModifiers'
import type {
  HostSessionBrowserOperations,
  HostSessionBrowserTarget
} from './host-session-browser-operations'
import { MobileWebBrowserFrameAssembler } from './mobile-web-browser-frame-assembler'

export function webHostSessionBrowserOperations(
  client: MobileWebBridgeClient
): HostSessionBrowserOperations {
  return {
    subscribe(target, request, listener) {
      const assembler = new MobileWebBrowserFrameAssembler()
      let active = true
      let unsubscribe = (): void => {}
      const subscription = client.browserSubscribe(
        { ...webTarget(target), ...request },
        (event) => {
          if (!active) {
            return
          }
          if (event.type !== 'frameChunk') {
            listener.onEvent(event)
            return
          }
          try {
            const frame = assembler.push(event)
            if (frame) {
              listener.onFrame(frame)
            }
          } catch (error) {
            active = false
            assembler.clear()
            unsubscribe()
            listener.onError(browserOperationError(error))
          }
        },
        (error) => {
          if (active) {
            listener.onError(browserOperationError(error))
          }
        }
      )
      unsubscribe = subscription.unsubscribe
      void subscription.ready.catch(() => {})
      return () => {
        active = false
        assembler.clear()
        unsubscribe()
      }
    },
    navigate(target, url) {
      return client.browserNavigate({ ...webTarget(target), url }, { timeoutMs: 30_000 })
    },
    async scroll(target, point, delta) {
      await client.browserPointer({
        ...webTarget(target),
        action: 'scroll',
        ...point,
        ...delta
      })
    },
    async click(target, point, button, modifiers, radius) {
      await client.browserPointer({
        ...webTarget(target),
        action: 'click',
        ...point,
        button,
        modifiers: modifiers as BrowserPointerModifier[],
        ...(radius === undefined ? {} : { radius })
      })
    },
    async insertText(target, text) {
      await client.browserKeyboard({ ...webTarget(target), action: 'insertText', text })
    },
    async keypress(target, key) {
      await client.browserKeyboard({ ...webTarget(target), action: 'keypress', key })
    },
    async dialog(target, action) {
      await client.browserDialog({ ...webTarget(target), action })
    },
    async back(target) {
      await client.browserBack(webTarget(target))
    },
    async forward(target) {
      await client.browserForward(webTarget(target))
    },
    async reload(target) {
      await client.browserReload(webTarget(target))
    }
  }
}

function webTarget(target: HostSessionBrowserTarget): {
  workspaceId: string
  pageId: string
} {
  return target
}

function browserOperationError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Browser command failed')
}
