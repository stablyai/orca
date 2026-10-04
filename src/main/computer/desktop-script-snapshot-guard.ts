import type {
  ComputerActionMetadata,
  ComputerActionResult,
  ComputerProviderCapabilities
} from '../../shared/runtime-types'
import { optionalStringParam } from './desktop-script-provider-params'
import type {
  BridgeRequest,
  BridgeSnapshot,
  NativeActionMethod
} from './desktop-script-provider-types'
import type { DesktopScriptSnapshotStore } from './desktop-script-snapshot-store'
import { RuntimeClientError } from './runtime-client-error'

export function guardedDesktopSnapshot(
  store: DesktopScriptSnapshotStore,
  capabilities: ComputerProviderCapabilities,
  method: NativeActionMethod,
  params: Record<string, unknown>
): BridgeSnapshot {
  assertDesktopGuardSupport(capabilities, method)
  const id = optionalStringParam(params, 'ifSnapshotId')
  const snapshot = id === undefined ? null : store.exact(id, params)
  if (
    !snapshot ||
    id === undefined ||
    id.length > 256 ||
    snapshot.truncation?.truncated === true ||
    !snapshot.elements?.some((element) => element.index === params.elementIndex)
  ) {
    throw new RuntimeClientError('precondition_failed', 'Snapshot precondition did not match')
  }
  return snapshot
}

export function guardedDesktopActionReceipt(
  action: ComputerActionMetadata,
  ifSnapshotId: string | undefined
): ComputerActionMetadata {
  if (ifSnapshotId === undefined) {
    return action
  }
  if (action.precondition?.state !== 'matched' || action.precondition.snapshotId !== ifSnapshotId) {
    throw new RuntimeClientError(
      'provider_incompatible',
      'Provider returned no guarded action receipt'
    )
  }
  if (
    action.path !== 'accessibility' ||
    !['primaryAction', 'setValue', 'invoke', 'select', 'toggle'].some(
      (name) => name === action.actionName
    )
  ) {
    throw new RuntimeClientError(
      'provider_incompatible',
      'Provider returned an invalid guarded action receipt'
    )
  }
  return {
    path: 'accessibility',
    actionName: action.actionName,
    precondition: { state: 'matched', snapshotId: ifSnapshotId },
    verification: { state: 'unverified', reason: 'accessibility_action_unasserted' }
  }
}

export function guardedDesktopActionResult(
  action: ComputerActionMetadata,
  snapshotId: string
): ComputerActionResult {
  // Retain the legacy result envelope without publishing an observation after the effect.
  return {
    action,
    snapshot: {
      id: snapshotId,
      app: { name: '', bundleId: null, pid: 0 },
      window: { title: '', width: 0, height: 0 },
      coordinateSpace: 'window',
      treeText: '',
      elementCount: 0,
      focusedElementId: null
    },
    screenshot: null,
    screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
  }
}

export function assertDesktopGuardSupport(
  capabilities: ComputerProviderCapabilities | undefined,
  method: string | null
): void {
  const guards = capabilities?.guardedActions
  if (guards?.version !== 1 || !guards.actions.some((action) => action === method)) {
    throw new RuntimeClientError(
      'unsupported_capability',
      'This provider does not support guarded actions'
    )
  }
}

export function assertDesktopBridgeGuardSupport(
  capabilities: ComputerProviderCapabilities | undefined,
  request: BridgeRequest
): void {
  const method =
    request.tool === 'set_value'
      ? 'setValue'
      : request.tool === 'perform_secondary_action'
        ? 'performSecondaryAction'
        : request.tool === 'click'
          ? 'click'
          : null
  assertDesktopGuardSupport(capabilities, method)
}
