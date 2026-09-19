import { createHash } from 'node:crypto'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { PtyProviderOperationRetry } from './pty-provider-contract'
import type { SshPtyOwnershipTransferPublishedRoute } from './ssh-pty-ownership-transfer-route-registry'

type CallerOperation = Readonly<{
  routeFingerprint: string
  payloadFingerprint: string
  kind: 'input' | 'control'
}>

export class SshPtyTransferCallerOperations {
  private readonly callerOperationsByPtyId = new Map<string, Map<string, CallerOperation>>()

  resolve(
    route: SshPtyOwnershipTransferPublishedRoute,
    kind: CallerOperation['kind'],
    payload: string,
    retry?: PtyProviderOperationRetry
  ): string | undefined {
    if (!retry) {
      return undefined
    }
    const operationId = retry.operationId
    if (!operationId || operationId.length > 512) {
      throw new Error(`pty_ownership_transfer_${kind}_id_invalid`)
    }
    const operations = this.callerOperationsByPtyId.get(route.ptyId) ?? new Map()
    const operation: CallerOperation = Object.freeze({
      routeFingerprint: fingerprintRoute(route.identity),
      payloadFingerprint: fingerprintPayload(kind, payload),
      kind
    })
    const previous = operations.get(operationId)
    if (previous) {
      if (
        previous.kind !== operation.kind ||
        previous.routeFingerprint !== operation.routeFingerprint ||
        previous.payloadFingerprint !== operation.payloadFingerprint
      ) {
        throw new Error('pty_ownership_transfer_operation_conflict')
      }
      return operationId
    }
    if (operations.size >= route.capabilities.maxInputIds) {
      throw new Error('pty_ownership_transfer_retry_window_exhausted')
    }
    operations.set(operationId, operation)
    this.callerOperationsByPtyId.set(route.ptyId, operations)
    return operationId
  }

  read(ptyId: string, operationId: string): CallerOperation | undefined {
    if (!operationId || operationId.length > 512) {
      return undefined
    }
    return this.callerOperationsByPtyId.get(ptyId)?.get(operationId)
  }

  assertRoute(operation: CallerOperation, route: SshPtyOwnershipTransferPublishedRoute): void {
    if (operation.routeFingerprint !== fingerprintRoute(route.identity)) {
      throw new Error('pty_ownership_transfer_operation_route_mismatch')
    }
  }

  retire(ptyId: string, operationId: string): void {
    const operations = this.callerOperationsByPtyId.get(ptyId)
    operations?.delete(operationId)
    if (operations?.size === 0) {
      this.callerOperationsByPtyId.delete(ptyId)
    }
  }

  delete(ptyId: string): void {
    this.callerOperationsByPtyId.delete(ptyId)
  }

  clear(): void {
    this.callerOperationsByPtyId.clear()
  }
}

function fingerprintRoute(identity: PtyOwnershipTransferWireIdentity): string {
  return fingerprint([
    identity.bridgeId,
    identity.terminalId,
    identity.incarnationId,
    identity.ownerLease,
    String(identity.sourceOwnerGeneration),
    identity.destinationRuntimeId
  ])
}

function fingerprintPayload(kind: CallerOperation['kind'], payload: string): string {
  return fingerprint([kind, payload])
}

function fingerprint(parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    hash.update(String(part.length))
    hash.update(':')
    hash.update(part)
  }
  return hash.digest('hex')
}
