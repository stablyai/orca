import type { FeatureInteractionId } from '../../../shared/feature-interactions'
import { isBrowserPaneUiRuntimeRpcParams } from '../../../shared/runtime-rpc-feature-interaction-source'
import type { OrcaRuntimeService } from '../orca-runtime'

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

export function recordRuntimeFeatureInteraction(
  runtime: OrcaRuntimeService,
  method: string,
  result: unknown,
  alreadyRecorded?: Set<FeatureInteractionId>,
  rawParams?: unknown
): void {
  const id = getRuntimeFeatureInteractionId(method, result, rawParams)
  if (!id || alreadyRecorded?.has(id)) {
    return
  }
  try {
    runtime.recordFeatureInteraction(id)
    alreadyRecorded?.add(id)
  } catch {
    // Best-effort education state must not break runtime tools.
  }
}

function hasBooleanResult(value: unknown, key: string): boolean {
  return (
    value !== null && typeof value === 'object' && (value as Record<string, unknown>)[key] === true
  )
}
