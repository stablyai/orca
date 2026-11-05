import { isRangedFileDocumentMethod } from '../../../shared/ranged-file-document'
import { getRemoteRuntimeSharedControlDiagnostics } from './runtime-environment-request-connections'

export function shouldRouteCallBySupport(method: string, environmentId: string): boolean {
  if (method === 'status.get') {
    return false
  }
  if (method === 'session.tabs.list' || method === 'session.tabs.listAll') {
    // Use ready shared sockets for tab reads; one-shot recovery remains available during reconnect (#26785).
    return getRemoteRuntimeSharedControlDiagnostics(environmentId)?.state === 'ready'
  }
  return true
}

export function shouldRouteSubscriptionBySupport(method: string): boolean {
  if (method === 'browser.screencast' || method === 'terminal.multiplex') {
    return false
  }
  return (
    isRangedFileDocumentMethod(method) ||
    method === 'runtime.clientEvents.subscribe' ||
    method === 'session.tabs.subscribe' ||
    method === 'session.tabs.subscribeAll' ||
    method === 'accounts.subscribe' ||
    method === 'notifications.subscribe' ||
    method === 'files.watch'
  )
}
