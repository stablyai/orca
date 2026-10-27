import { registerBrowserExtensionNamespace } from '../browser-extension-namespace-registry'

/** Events Orca forwards from its own session handlers (browser-extension-web-request.ts). */
export const FORWARDED_WEB_REQUEST_EVENTS = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred'
] as const

/** Replaces the native events, which never fire in Electron 43; onAuthRequired stays native. */
export function registerWebRequestNamespace(): void {
  registerBrowserExtensionNamespace('webRequest', {
    permission: 'webRequest',
    methods: {},
    events: FORWARDED_WEB_REQUEST_EVENTS
  })
}
