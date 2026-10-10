/** The browser methods a paired phone may call: page commands, input and the screencast. */
export const MOBILE_BROWSER_RPC_METHODS = [
  'browser.back',
  'browser.dialogAccept',
  'browser.dialogDismiss',
  'browser.forward',
  'browser.goto',
  'browser.keyboardInsertText',
  'browser.keypress',
  'browser.mouseDown',
  'browser.mouseClick',
  'browser.mouseMove',
  'browser.mouseUp',
  'browser.mouseWheel',
  'browser.reload',
  'browser.screencast',
  'browser.screencast.ack',
  'browser.screencast.unsubscribe',
  'browser.tabCreate',
  'browser.viewport'
] as const
