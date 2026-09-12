import { createHash } from 'node:crypto'
import {
  parsePtyOwnershipTransferWireIdentity,
  parsePtyOwnershipTransferPrepareRequest,
  PTY_OWNERSHIP_TRANSFER_METHODS,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
} from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS } from '../../shared/pty-ownership-transfer-runtime-methods'
import {
  PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
  type PtyOwnershipTransferSourceGrant,
  type PtyOwnershipTransferSourceGrantRequest
} from '../../shared/pty-ownership-transfer-source-grant'
import {
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from '../../shared/pty-ownership-transfer-surface-binding'
import type { RuntimePtyOwnershipTransferAttachmentBinding } from './runtime-pty-ownership-transfer-attachment-binding'
import type { RuntimePtySourceAuthorityRegistry } from './runtime-pty-source-authority-registry'

const DEFAULT_SOURCE_GRANT_TTL_MS = 2 * 60 * 1_000
const MAX_SOURCE_GRANTS = 256

type SourceGrantOptions = Readonly<{
  runtimeId?: string
  grantTtlMs?: number
  now?: () => number
  mutationEnabled: () => boolean
  sourceAuthority: (terminalId: string) => ReturnType<RuntimePtySourceAuthorityRegistry['resolve']>
}>

export class RuntimePtyOwnershipTransferSourceGrants {
  private readonly runtimeId: string | undefined
  private readonly grantTtlMs: number
  private readonly now: () => number
  private readonly grants = new Map<
    string,
    Readonly<{
      grant: PtyOwnershipTransferSourceGrant
      clientId: number
      transportGeneration: number
      pairedDeviceId: string
      issuedAt: number
      expiresAt: number
    }>
  >()
  private readonly mutationEnabled: () => boolean
  private readonly sourceAuthority: SourceGrantOptions['sourceAuthority']

  constructor(options: SourceGrantOptions) {
    this.runtimeId = options.runtimeId
    this.grantTtlMs = boundedGrantTtl(options.grantTtlMs)
    this.now = options.now ?? Date.now
    this.mutationEnabled = options.mutationEnabled
    this.sourceAuthority = options.sourceAuthority
  }

  /**
   * Authenticates a paired-runtime mutation against the host's current PTY authority.
   * The RPC layer authenticates the caller/device; this check authenticates the exact
   * process incarnation and prevents a stale or self-targeted wire identity from mutating.
   */
  authorizeMutationRequest(
    method: string,
    request: unknown,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): boolean {
    if (!isRuntimeOwnershipTransferMutationMethod(method)) {
      return false
    }
    if (
      !Number.isSafeInteger(binding.clientId) ||
      binding.clientId <= 0 ||
      !Number.isSafeInteger(binding.transportGeneration) ||
      binding.transportGeneration! <= 0 ||
      !binding.pairedDeviceId ||
      binding.isStale()
    ) {
      return false
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return false
    }
    const record = request as { version?: unknown }
    if (record.version !== PTY_OWNERSHIP_TRANSFER_WIRE_VERSION) {
      return false
    }
    let identity: ReturnType<typeof parsePtyOwnershipTransferWireIdentity>
    try {
      identity = parsePtyOwnershipTransferWireIdentity(request)
    } catch {
      return false
    }
    if (this.runtimeId !== undefined && identity.destinationRuntimeId === this.runtimeId) {
      return false
    }
    this.pruneExpiredGrants()
    const issued = this.grants.get(identity.bridgeId)
    if (
      !issued ||
      this.now() >= issued.expiresAt ||
      issued.clientId !== binding.clientId ||
      issued.transportGeneration !== binding.transportGeneration ||
      issued.pairedDeviceId !== binding.pairedDeviceId ||
      !samePtyOwnershipTransferIdentity(issued.grant.identity, identity)
    ) {
      return false
    }
    if (isPrepareMutationMethod(method)) {
      let prepare: ReturnType<typeof parsePtyOwnershipTransferPrepareRequest>
      try {
        prepare = parsePtyOwnershipTransferPrepareRequest(request)
      } catch {
        return false
      }
      if (
        !prepare.surfacePublication ||
        !samePtyOwnershipTransferSurfaceBinding(
          prepare.surfacePublication.surfaceBinding,
          issued.grant.surfaceBinding
        )
      ) {
        return false
      }
    }
    const source = this.sourceAuthority(identity.terminalId)
    return (
      source !== null &&
      identity.bridgeId ===
        derivePairedGrantBridgeId(
          source,
          identity,
          issued.grant.surfaceBinding,
          issued.transportGeneration,
          issued.pairedDeviceId
        ) &&
      source.terminalId === identity.terminalId &&
      source.incarnationId === identity.incarnationId &&
      source.ownerLease === identity.ownerLease &&
      source.sourceOwnerGeneration === identity.sourceOwnerGeneration
    )
  }

  /** Returns a source-minted identity only while the exact host incarnation is current. */
  issueOwnershipTransferSourceGrant(
    request: PtyOwnershipTransferSourceGrantRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): PtyOwnershipTransferSourceGrant {
    if (
      !this.mutationEnabled() ||
      binding.isStale() ||
      !Number.isSafeInteger(binding.clientId) ||
      binding.clientId <= 0 ||
      !Number.isSafeInteger(binding.transportGeneration) ||
      binding.transportGeneration! <= 0 ||
      !binding.pairedDeviceId
    ) {
      throw new Error('pty_ownership_transfer_runtime_request_stale')
    }
    if (this.runtimeId !== undefined && request.destinationRuntimeId === this.runtimeId) {
      throw new Error('pty_ownership_transfer_runtime_self_target')
    }
    const source = this.sourceAuthority(request.terminalId)
    if (!source) {
      throw new Error('pty_ownership_transfer_source_authority_unavailable')
    }
    if (this.runtimeId !== undefined && request.destinationRuntimeId === this.runtimeId) {
      throw new Error('pty_ownership_transfer_source_self_target')
    }
    const identity = Object.freeze({
      bridgeId: derivePairedGrantBridgeId(
        source,
        request,
        request.surfaceBinding,
        binding.transportGeneration!,
        binding.pairedDeviceId
      ),
      terminalId: source.terminalId,
      incarnationId: source.incarnationId,
      ownerLease: source.ownerLease,
      sourceOwnerGeneration: source.sourceOwnerGeneration,
      destinationRuntimeId: request.destinationRuntimeId
    })
    const grant = Object.freeze({
      version: PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
      identity,
      surfaceBinding: request.surfaceBinding
    })
    const issuedAt = this.now()
    this.pruneExpiredGrants(issuedAt)
    this.grants.delete(grant.identity.bridgeId)
    while (this.grants.size >= MAX_SOURCE_GRANTS) {
      const oldest = this.grants.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.grants.delete(oldest)
    }
    this.grants.set(
      grant.identity.bridgeId,
      Object.freeze({
        grant,
        clientId: binding.clientId,
        transportGeneration: binding.transportGeneration!,
        pairedDeviceId: binding.pairedDeviceId,
        issuedAt,
        expiresAt: issuedAt + this.grantTtlMs
      })
    )
    return grant
  }

  private pruneExpiredGrants(now = this.now()): void {
    for (const [bridgeId, issued] of this.grants) {
      if (now >= issued.expiresAt) {
        this.grants.delete(bridgeId)
      }
    }
  }

  clear(): void {
    this.grants.clear()
  }
}

function derivePairedGrantBridgeId(
  source: Readonly<{
    terminalId: string
    incarnationId: string
    ownerLease: string
    sourceOwnerGeneration: number
  }>,
  destination: Readonly<{ destinationRuntimeId: string }>,
  surfaceBinding: PtyOwnershipTransferSurfaceBinding,
  transportGeneration: number,
  pairedDeviceId: string
): string {
  const digest = createHash('sha256')
    .update('runtime-pty-ownership-transfer-grant\0')
    .update(source.terminalId)
    .update('\0')
    .update(source.incarnationId)
    .update('\0')
    .update(source.ownerLease)
    .update('\0')
    .update(String(source.sourceOwnerGeneration))
    .update('\0')
    .update(destination.destinationRuntimeId)
    .update('\0')
    .update(surfaceBinding.executionHostId)
    .update('\0')
    .update(surfaceBinding.workspaceKey)
    .update('\0')
    .update(surfaceBinding.tabId)
    .update('\0')
    .update(surfaceBinding.leafId)
    .update('\0')
    .update(surfaceBinding.ptyId)
    .update('\0')
    .update(String(transportGeneration))
    .update('\0')
    .update(pairedDeviceId)
    .digest('base64url')
  return `runtime-${digest}`
}

function isPrepareMutationMethod(method: string): boolean {
  return method === PTY_OWNERSHIP_TRANSFER_METHODS.prepare || method.endsWith('.prepareSource')
}

function boundedGrantTtl(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SOURCE_GRANT_TTL_MS
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10 * 60 * 1_000) {
    throw new Error('pty_ownership_transfer_source_grant_ttl_invalid')
  }
  return value
}

function isRuntimeOwnershipTransferMutationMethod(method: string): boolean {
  return (
    Object.values(PTY_OWNERSHIP_TRANSFER_METHODS).includes(
      method as (typeof PTY_OWNERSHIP_TRANSFER_METHODS)[keyof typeof PTY_OWNERSHIP_TRANSFER_METHODS]
    ) ||
    Object.values(PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS).includes(
      method as (typeof PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS)[keyof typeof PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS]
    )
  )
}
