import type { AppCaller, AppDocumentTarget } from '../../../shared/app-ipc/app-caller'
import type { AppChannel } from '../../../shared/app-ipc/app-channel-manifest'
import type { FanoutEventSource } from '../../runtime/events/event-listener-fanout'

export type { AppCaller, AppDocumentTarget }

export type AppWindow = FanoutEventSource & {
  readonly id: number
  isDestroyed(): boolean
  once(event: string, listener: (...args: any[]) => void): unknown
}

export type AppDocument = AppWindow & { readonly caller: AppCaller }

// Handler argument tuples remain owned by each family's existing contract.
export type AppHandler = (caller: AppCaller, ...args: any[]) => unknown

export type AppIpcHost = {
  handle(channel: AppChannel, listener: AppHandler): void
  on(channel: AppChannel, listener: AppHandler): void
  removeHandler(channel: AppChannel): void
  removeAllListeners(channel: AppChannel): void
  window(caller: AppCaller): AppWindow
  isRegisteredMain(caller: AppCaller): boolean
  document(caller: AppCaller): AppDocument
  publish(channel: string, payload: unknown, target: AppDocumentTarget): void
  flushDocumentStorage(caller: AppCaller): void
  isCurrent(caller: AppCaller): boolean
}

let host: AppIpcHost | undefined

export function setAppIpcHost(value: AppIpcHost): void {
  host = value
}

function appIpcHost(): AppIpcHost {
  if (!host) {
    throw new Error('Application IPC host has not been installed')
  }
  return host
}

export function registerAppHandler(channel: AppChannel, listener: AppHandler): void {
  appIpcHost().handle(channel, listener)
}

export function registerAppListener(channel: AppChannel, listener: AppHandler): void {
  appIpcHost().on(channel, listener)
}

export function removeAppHandler(channel: AppChannel): void {
  appIpcHost().removeHandler(channel)
}

export function removeAppListeners(channel: AppChannel): void {
  appIpcHost().removeAllListeners(channel)
}

export function appDocumentFor(caller: AppCaller): AppDocument {
  return appIpcHost().document(caller)
}

export function isCurrentAppDocument(caller: AppCaller): boolean {
  return appIpcHost().isCurrent(caller)
}

export function publishToDocuments(
  channel: string,
  payload: unknown,
  target: AppDocumentTarget
): void {
  appIpcHost().publish(channel, payload, target)
}

export function flushAppDocumentStorage(caller: AppCaller): void {
  appIpcHost().flushDocumentStorage(caller)
}

export function appWindowFor(caller: AppCaller): AppWindow {
  return appIpcHost().window(caller)
}

export function isRegisteredMainAppCaller(caller: AppCaller): boolean {
  return appIpcHost().isRegisteredMain(caller)
}
