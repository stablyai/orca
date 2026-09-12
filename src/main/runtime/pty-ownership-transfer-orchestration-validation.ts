import type { IPtyProvider } from '../providers/types'
import type { SshPtyOwnershipTransferClient } from '../providers/ssh-pty-ownership-transfer-client'
import {
  PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION,
  type PtyOwnershipBridgeCapabilities
} from '../../shared/pty-ownership-bridge-contract'
import type {
  PtyOwnershipTransferPreflightBlocker,
  PtyOwnershipTransferPreflightRequest,
  PtyOwnershipTransferPreflightResult
} from '../../shared/pty-ownership-transfer-orchestration'

type DirectSshTransferProvider = IPtyProvider & {
  ownershipTransfer?: Pick<SshPtyOwnershipTransferClient, 'status'>
}

export async function readPtyOwnershipTransferCapabilities(
  provider: {
    getOwnershipBridgeCapabilities?: (options?: { signal?: AbortSignal }) =>
      | PtyOwnershipBridgeCapabilities
      | null
      | Promise<PtyOwnershipBridgeCapabilities | null>
  }
): Promise<PtyOwnershipBridgeCapabilities | null> {
  try {
    return (await provider.getOwnershipBridgeCapabilities?.()) ?? null
  } catch {
    return null
  }
}

export function transferCapabilityBlocker(
  provider: DirectSshTransferProvider,
  capabilities: PtyOwnershipBridgeCapabilities
): PtyOwnershipTransferPreflightBlocker | null {
  if (!capabilities.protocolVersions.includes(PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION)) {
    return 'protocol-version-unsupported'
  }
  if (!capabilities.inputDeduplication) {
    return 'input-deduplication-unsupported'
  }
  if (!capabilities.rollback) {
    return 'rollback-unsupported'
  }
  if (!provider.ownershipTransfer) {
    return 'transfer-transport-unavailable'
  }
  if (!capabilities.liveTransfer) {
    return 'live-transfer-disabled'
  }
  if (!capabilities.destinationOutput) {
    return 'destination-output-unsupported'
  }
  if (!capabilities.postCommitReplay) {
    return 'post-commit-replay-unsupported'
  }
  if (!capabilities.destinationControl) {
    return 'destination-control-unsupported'
  }
  if (!capabilities.authoritativeExit) {
    return 'authoritative-exit-unsupported'
  }
  return null
}

export function runtimeOwnedCapabilityBlocker(
  capabilities: PtyOwnershipBridgeCapabilities
): PtyOwnershipTransferPreflightBlocker {
  if (!capabilities.protocolVersions.includes(PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION)) {
    return 'protocol-version-unsupported'
  }
  if (!capabilities.inputDeduplication) {
    return 'input-deduplication-unsupported'
  }
  if (!capabilities.rollback) {
    return 'rollback-unsupported'
  }
  if (!capabilities.liveTransfer) {
    return 'live-transfer-disabled'
  }
  if (!capabilities.destinationOutput) {
    return 'destination-output-unsupported'
  }
  if (!capabilities.postCommitReplay) {
    return 'post-commit-replay-unsupported'
  }
  if (!capabilities.destinationControl) {
    return 'destination-control-unsupported'
  }
  if (!capabilities.authoritativeExit) {
    return 'authoritative-exit-unsupported'
  }
  return 'transfer-transport-unavailable'
}

export function createPtyOwnershipTransferPreflightResult(
  topology: PtyOwnershipTransferPreflightResult['topology'],
  blocker: PtyOwnershipTransferPreflightBlocker | null,
  capabilities: PtyOwnershipBridgeCapabilities | null = null,
  hasTransferTransport = false
): PtyOwnershipTransferPreflightResult {
  return Object.freeze({
    topology,
    transferSupported: blocker === null,
    statusQuerySupported: Boolean(
      capabilities?.statusQuery === true &&
        capabilities.protocolVersions.includes(PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION) &&
        hasTransferTransport
    ),
    blocker,
    capabilities
  })
}

export function assertPtyOwnershipTransferPreflightRequest(
  request: PtyOwnershipTransferPreflightRequest
): void {
  if (
    typeof request !== 'object' ||
    request === null ||
    (request.connectionId !== null &&
      (typeof request.connectionId !== 'string' || !request.connectionId)) ||
    typeof request.ptyId !== 'string' ||
    !request.ptyId ||
    typeof request.destinationRuntimeId !== 'string' ||
    !request.destinationRuntimeId
  ) {
    throw new Error('pty_ownership_transfer_preflight_request_invalid')
  }
}

export function isPtyOwnershipTransferMethodNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const record = error as { code?: unknown; message?: unknown }
  return (
    record.code === 'method_not_found' ||
    (typeof record.message === 'string' && /unknown method/i.test(record.message))
  )
}
