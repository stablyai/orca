import type { IPtyProvider } from '../providers/types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { parseRemoteRuntimePtyId } from '../../shared/remote-runtime-pty-id'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import type {
  PtyOwnershipTransferPreflightBlocker,
  PtyOwnershipTransferPreflightRequest,
  PtyOwnershipTransferPreflightResult,
  PtyOwnershipTransferStatusProbeRequest
} from '../../shared/pty-ownership-transfer-orchestration'
import {
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferStatusResult
} from '../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferPreflightResult } from '../../shared/pty-ownership-transfer-orchestration'
import { parsePtyOwnershipTransferStatusResult } from '../../shared/pty-ownership-transfer-wire-results'
import type {
  PtyOwnershipTransferSourceGrant,
  PtyOwnershipTransferSourceGrantRequest
} from '../../shared/pty-ownership-transfer-source-grant'
import type { RuntimePtyOwnershipTransferAttachmentBinding } from '../providers/runtime-pty-ownership-transfer-source-adapter'
import {
  assertDirectSshPtyOwnershipTransferStatusIdentity,
  assertPtyOwnershipTransferStatusRequest,
  assertPtyOwnershipTransferStatusResponseIdentity,
  assertRuntimeOwnedPtyOwnershipTransferStatusIdentity
} from './pty-ownership-transfer-status-validation'
import {
  assertPtyOwnershipTransferPreflightRequest,
  createPtyOwnershipTransferPreflightResult,
  isPtyOwnershipTransferMethodNotFound,
  readPtyOwnershipTransferCapabilities,
  runtimeOwnedCapabilityBlocker,
  transferCapabilityBlocker
} from './pty-ownership-transfer-orchestration-validation'

type DirectSshTransferProvider = IPtyProvider & {
  ownershipTransfer?: { status: NonNullable<IPtyProvider['getOwnershipTransferStatus']> }
}

type TrackedPty = Readonly<{ connectionId: string | null; incarnationId: string | null }>

export type RuntimeOwnedPtyOwnershipTransferReadOnlySource = Readonly<{
  reconcileProvider: (provider: IPtyProvider) => Promise<unknown>
  getOwnershipBridgeCapabilities: () =>
    | PtyOwnershipBridgeCapabilities
    | Promise<PtyOwnershipBridgeCapabilities>
  getOwnershipTransferStatus: (
    request: Parameters<NonNullable<IPtyProvider['getOwnershipTransferStatus']>>[0],
    options?: Parameters<NonNullable<IPtyProvider['getOwnershipTransferStatus']>>[1]
  ) => Promise<PtyOwnershipTransferStatusResult> | PtyOwnershipTransferStatusResult
  issueOwnershipTransferSourceGrant?: (
    request: PtyOwnershipTransferSourceGrantRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) => PtyOwnershipTransferSourceGrant
}>

type OrchestrationOptions = Readonly<{
  runtimeId: string
  getSshProvider: (connectionId: string) => IPtyProvider | undefined
  getLocalProvider?: () => IPtyProvider | null
  getLocalReadOnlySource?: () => RuntimeOwnedPtyOwnershipTransferReadOnlySource | null
  inspectPty: (ptyId: string) => TrackedPty | null
  /** Destination construction is intentionally opt-in until its output sink is durable. */
  hasDestinationAdapter?: () => boolean
  /** Separate release gate; registry construction alone must never enable mutation. */
  mutationEnabled?: () => boolean
  /** Read-only RPC bridge for PTYs owned by an independently paired runtime. */
  callPairedRuntimeRpc?: (
    environmentId: string,
    method: string,
    params: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ) => Promise<unknown>
}>

/** Read-only production gate for direct-SSH and runtime-owned transfer sources. */
export class PtyOwnershipTransferOrchestrator {
  constructor(private readonly options: OrchestrationOptions) {}

  async preflight(
    request: PtyOwnershipTransferPreflightRequest
  ): Promise<PtyOwnershipTransferPreflightResult> {
    assertPtyOwnershipTransferPreflightRequest(request)
    const directSsh = parseAppSshPtyId(request.ptyId)
    if (directSsh) {
      return await this.preflightDirectSsh(request, directSsh)
    }
    const paired = parseRemoteRuntimePtyId(request.ptyId)
    if (paired) {
      if (!paired.environmentId || !this.options.callPairedRuntimeRpc) {
        return createPtyOwnershipTransferPreflightResult(
          'paired-runtime-reference',
          'source-runtime-probe-required'
        )
      }
      try {
        const response = await this.options.callPairedRuntimeRpc(
          paired.environmentId,
          'pty.ownershipTransfer.preflightSource',
          { ptyId: paired.handle, destinationRuntimeId: request.destinationRuntimeId },
          undefined
        )
        const parsed = parsePtyOwnershipTransferPreflightResult(response)
        if (parsed.topology !== 'runtime-owned') {
          throw new Error('pty_ownership_transfer_preflight_topology_mismatch')
        }
        return Object.freeze({ ...parsed, topology: 'paired-runtime-reference' as const })
      } catch (error) {
        if (isPtyOwnershipTransferMethodNotFound(error)) {
          return createPtyOwnershipTransferPreflightResult(
            'paired-runtime-reference',
            'source-capabilities-unavailable'
          )
        }
        throw error
      }
    }
    return await this.preflightRuntimeOwned(request)
  }

  private async preflightDirectSsh(
    request: PtyOwnershipTransferPreflightRequest,
    parsed: NonNullable<ReturnType<typeof parseAppSshPtyId>>
  ): Promise<PtyOwnershipTransferPreflightResult> {
    const topologyBlocker = this.inspectDirectSshTopology(request, parsed)
    if (topologyBlocker) {
      return createPtyOwnershipTransferPreflightResult('direct-ssh', topologyBlocker)
    }
    const provider = this.options.getSshProvider(request.connectionId!) as
      | DirectSshTransferProvider
      | undefined
    if (!provider) {
      return createPtyOwnershipTransferPreflightResult('direct-ssh', 'source-provider-unavailable')
    }
    const capabilities = await readPtyOwnershipTransferCapabilities(provider)
    if (!capabilities) {
      return createPtyOwnershipTransferPreflightResult(
        'direct-ssh',
        'source-capabilities-unavailable'
      )
    }
    // Source support alone cannot authorize cutover before destination publication owns live output.
    const blocker =
      transferCapabilityBlocker(provider, capabilities) ??
      (this.options.hasDestinationAdapter?.() !== true
        ? 'destination-adapter-unavailable'
        : this.options.mutationEnabled?.() === true
          ? null
          : 'production-transfer-disabled')
    return createPtyOwnershipTransferPreflightResult(
      'direct-ssh',
      blocker,
      capabilities,
      provider.ownershipTransfer !== undefined
    )
  }

  private async preflightRuntimeOwned(
    request: PtyOwnershipTransferPreflightRequest
  ): Promise<PtyOwnershipTransferPreflightResult> {
    if (request.connectionId !== null) {
      return createPtyOwnershipTransferPreflightResult('runtime-owned', 'source-not-direct-ssh')
    }
    if (request.destinationRuntimeId === this.options.runtimeId) {
      return createPtyOwnershipTransferPreflightResult(
        'runtime-owned',
        'destination-runtime-not-distinct'
      )
    }
    const tracked = this.options.inspectPty(request.ptyId)
    if (!tracked || tracked.connectionId !== null) {
      return createPtyOwnershipTransferPreflightResult('runtime-owned', 'source-terminal-untracked')
    }
    if (!tracked.incarnationId) {
      return createPtyOwnershipTransferPreflightResult(
        'runtime-owned',
        'source-terminal-incarnation-unavailable'
      )
    }
    const provider = this.options.getLocalProvider?.()
    if (!provider) {
      return createPtyOwnershipTransferPreflightResult(
        'runtime-owned',
        'source-provider-unavailable'
      )
    }
    const readOnlySource = this.options.getLocalReadOnlySource?.() ?? null
    if (readOnlySource) {
      try {
        await readOnlySource.reconcileProvider(provider)
      } catch {
        return createPtyOwnershipTransferPreflightResult(
          'runtime-owned',
          'source-capabilities-unavailable'
        )
      }
    }
    const capabilities = readOnlySource
      ? await readOnlySource.getOwnershipBridgeCapabilities()
      : await readPtyOwnershipTransferCapabilities(provider)
    if (!capabilities) {
      return createPtyOwnershipTransferPreflightResult(
        'runtime-owned',
        'source-capabilities-unavailable'
      )
    }
    const blocker = runtimeOwnedCapabilityBlocker(capabilities)
    return createPtyOwnershipTransferPreflightResult(
      'runtime-owned',
      blocker,
      capabilities,
      readOnlySource !== null || provider.getOwnershipTransferStatus !== undefined
    )
  }

  async status(
    request: PtyOwnershipTransferStatusProbeRequest
  ): Promise<PtyOwnershipTransferStatusResult> {
    assertPtyOwnershipTransferStatusRequest(request)
    const paired = parseRemoteRuntimePtyId(request.ptyId)
    if (paired?.environmentId && this.options.callPairedRuntimeRpc) {
      if (
        request.identity.terminalId !== paired.handle ||
        request.identity.destinationRuntimeId !== request.destinationRuntimeId
      ) {
        throw new Error('pty_ownership_transfer_status_identity_mismatch')
      }
      const preflight = await this.preflight(request)
      if (!preflight.statusQuerySupported) {
        throw new Error(
          `pty_ownership_transfer_status_unsupported:${preflight.blocker ?? 'status-query'}`
        )
      }
      const response = await this.options.callPairedRuntimeRpc(
        paired.environmentId,
        'pty.ownershipTransfer.statusSource',
        {
          ptyId: paired.handle,
          destinationRuntimeId: request.destinationRuntimeId,
          identity: request.identity,
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs })
        },
        request.timeoutMs === undefined ? undefined : { timeoutMs: request.timeoutMs }
      )
      const parsed = parsePtyOwnershipTransferStatusResult(response)
      assertPtyOwnershipTransferStatusResponseIdentity(parsed, request.identity)
      return parsed
    }
    if (parseAppSshPtyId(request.ptyId)) {
      assertDirectSshPtyOwnershipTransferStatusIdentity(request, this.options.runtimeId)
    } else if (!parseRemoteRuntimePtyId(request.ptyId)) {
      assertRuntimeOwnedPtyOwnershipTransferStatusIdentity(request)
    }
    const preflight = await this.preflight(request)
    if (!preflight.statusQuerySupported) {
      throw new Error(
        `pty_ownership_transfer_status_unsupported:${preflight.blocker ?? 'status-query'}`
      )
    }
    if (this.options.inspectPty(request.ptyId)?.incarnationId !== request.identity.incarnationId) {
      throw new Error('pty_ownership_transfer_status_identity_mismatch')
    }
    if (preflight.topology === 'runtime-owned') {
      const provider = this.options.getLocalProvider?.()
      const readOnlySource = this.options.getLocalReadOnlySource?.() ?? null
      const status = readOnlySource?.getOwnershipTransferStatus.bind(readOnlySource)
      if (!provider || (!status && !provider.getOwnershipTransferStatus)) {
        throw new Error('pty_ownership_transfer_status_unsupported:transfer-transport-unavailable')
      }
      const response = await (status ?? provider.getOwnershipTransferStatus!)(
        { ...request.identity, version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION },
        request.timeoutMs === undefined ? undefined : { timeoutMs: request.timeoutMs }
      )
      assertPtyOwnershipTransferStatusResponseIdentity(response, request.identity)
      return response
    }
    const provider = this.options.getSshProvider(request.connectionId!) as
      | DirectSshTransferProvider
      | undefined
    if (!provider?.ownershipTransfer) {
      throw new Error('pty_ownership_transfer_status_unsupported:transfer-transport-unavailable')
    }
    return await provider.ownershipTransfer.status(
      { ...request.identity, version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION },
      request.timeoutMs === undefined ? undefined : { timeoutMs: request.timeoutMs }
    )
  }

  private inspectDirectSshTopology(
    request: PtyOwnershipTransferPreflightRequest,
    parsed: NonNullable<ReturnType<typeof parseAppSshPtyId>>
  ): PtyOwnershipTransferPreflightBlocker | null {
    if (request.destinationRuntimeId !== this.options.runtimeId) {
      return 'destination-runtime-mismatch'
    }
    if (parsed.connectionId !== request.connectionId) {
      return 'source-connection-mismatch'
    }
    const tracked = this.options.inspectPty(request.ptyId)
    if (!tracked || tracked.connectionId !== request.connectionId) {
      return 'source-terminal-untracked'
    }
    return tracked.incarnationId ? null : 'source-terminal-incarnation-unavailable'
  }
}
