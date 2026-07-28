import type { FeatureInteractionId } from '../../../shared/feature-interactions'
import { isBrowserPaneUiRuntimeRpcParams } from '../../../shared/runtime-rpc-feature-interaction-source'

export function getRuntimeFeatureInteractionId(
  method: string,
  result: unknown,
  rawParams?: unknown
): FeatureInteractionId | null {
  if (method === 'browser.profileImportFromBrowser') {
    return hasBooleanResult(result, 'ok') ? 'cookie-import' : null
  }
  if (method === 'browser.profileClearDefaultCookies') {
    return hasBooleanResult(result, 'cleared') ? 'cookie-import' : null
  }
  if (method === 'browser.screencast.unsubscribe') {
    return null
  }
  if (method.startsWith('browser.') && isBrowserPaneUiRuntimeRpcParams(rawParams)) {
    return null
  }
  if (method.startsWith('browser.') && !method.startsWith('browser.profile')) {
    return 'agent-browser-use'
  }
  if (method.startsWith('emulator.')) {
    return null
  }
  if (method === 'computer.permissions') {
    return 'computer-use-setup'
  }
  if (
    method.startsWith('computer.') &&
    method !== 'computer.capabilities' &&
    method !== 'computer.permissionsStatus'
  ) {
    return 'computer-use'
  }
  return method.startsWith('orchestration.') ? 'agent-orchestration' : null
}

function hasBooleanResult(value: unknown, key: string): boolean {
  return (
    value !== null && typeof value === 'object' && (value as Record<string, unknown>)[key] === true
  )
}
