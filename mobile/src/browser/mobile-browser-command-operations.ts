import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcMethodName } from '../transport/rpc-params-contract'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import {
  browserCommandUnreadReplySchema,
  browserNavigationSettledSchema
} from './browser-command-reply-schema'

// Hosted-page commands share refusal policy: raise host message, leave fallback copy at caller; only goto reads payload URL.
// Mutations with lost replies remain delivery-unknown and must not be retried; preserve transport rejection marker.
function browserPageCommandReading<Method extends RpcMethodName, Variant extends string, Value>(
  name: string,
  method: Method,
  read: RpcCompatibleReader<unknown, Variant, Value>
) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read
    })
  )
}

const unreadBrowserCommandReader = rpcResultVariant(
  'browser-command',
  browserCommandUnreadReplySchema
)

/** The twelve commands whose reply body nothing reads. */
function browserPageCommand<Method extends RpcMethodName>(name: string, method: Method) {
  return browserPageCommandReading(name, method, unreadBrowserCommandReader)
}

export const browserNavigate = browserPageCommandReading(
  'browser.navigate',
  'browser.goto',
  rpcResultVariant('browser-navigation-settled', browserNavigationSettledSchema)
)
export const browserGoBack = browserPageCommand('browser.go-back', 'browser.back')
export const browserGoForward = browserPageCommand('browser.go-forward', 'browser.forward')
export const browserReload = browserPageCommand('browser.reload-page', 'browser.reload')
export const browserPointerClick = browserPageCommand('browser.pointer-click', 'browser.mouseClick')
export const browserPointerMove = browserPageCommand('browser.pointer-move', 'browser.mouseMove')
export const browserPointerDown = browserPageCommand('browser.pointer-down', 'browser.mouseDown')
export const browserPointerUp = browserPageCommand('browser.pointer-up', 'browser.mouseUp')
export const browserPointerWheel = browserPageCommand('browser.pointer-wheel', 'browser.mouseWheel')
export const browserInsertText = browserPageCommand(
  'browser.insert-text',
  'browser.keyboardInsertText'
)
export const browserKeypress = browserPageCommand('browser.keypress', 'browser.keypress')
export const browserDialogAccept = browserPageCommand(
  'browser.dialog-accept',
  'browser.dialogAccept'
)
export const browserDialogDismiss = browserPageCommand(
  'browser.dialog-dismiss',
  'browser.dialogDismiss'
)
