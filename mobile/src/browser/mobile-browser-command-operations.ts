import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcMethodName } from '../transport/rpc-params-contract'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

/**
 * Every command the phone sends to a hosted browser page.
 *
 * All of them share one acceptance because the screen treats them alike: a refusal is raised with
 * the host's own message, which the caller then either shows or swallows as a transient automation
 * failure. What differs between them is the copy a message-less refusal falls back to, and that
 * stays at the call site. None reads the reply beyond `browser.goto`'s settled URL.
 *
 * These are mutations against a live page, so a lost reply is unknown rather than failed: no call
 * site retries one, and the delivery-unknown mark on a transport rejection is left intact.
 */
function browserPageCommand<Method extends RpcMethodName>(name: string, method: Method) {
  return bindDeferredRpcOperation(
    defineRpcOperation({
      name,
      method,
      acceptance: 'require-result-or-throw-message',
      barrier: 'after-caller-barrier',
      read: rpcUncheckedPayloadReader('browser-command')
    })
  )
}

export const browserNavigate = browserPageCommand('browser.navigate', 'browser.goto')
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
