import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import {
  clearSshPtyBuffer,
  resizeSshPty,
  sendSignalToSshPty,
  shutdownSshPty,
  writeSshPty,
  writeSshPtyWithSettlement
} from './ssh-pty-provider-rpc'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import type { SshPtyOwnershipTransferClient } from './ssh-pty-ownership-transfer-client'
import type { PtyProviderOperationRetry } from './pty-provider-contract'
import { settleOwnershipTransferWrite } from './pty-ownership-transfer-write-settlement'
import {
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
import { SshPtyOutgoingControlFence } from './ssh-pty-outgoing-control-fence'
import {
  SshPtyOwnershipTransferRouteRegistry,
  type SshPtyOwnershipTransferPublishedRoute
} from './ssh-pty-ownership-transfer-route-registry'

/** Switches provider controls from legacy relay routes to a published transfer attachment. */
export class SshPtyOwnershipTransferProviderControls {
  private readonly routes: SshPtyOwnershipTransferRouteRegistry
  private readonly outgoingControlFence: SshPtyOutgoingControlFence

  constructor(
    private readonly connectionId: string,
    private readonly mux: SshChannelMultiplexer,
    client: SshPtyOwnershipTransferClient,
    private readonly providerGeneration: number,
    private readonly livePtyIds: Set<string>
  ) {
    this.outgoingControlFence = new SshPtyOutgoingControlFence(connectionId, providerGeneration)
    this.routes = new SshPtyOwnershipTransferRouteRegistry(client, providerGeneration, {
      isTransportAvailable: () => !mux.isDisposed(),
      assertControlAllowed: (id) => this.outgoingControlFence.assertControlAllowed(id),
      ...(typeof mux.onDispose === 'function'
        ? { onTransportLost: (callback: () => void) => client.onTransportLost(callback) }
        : {})
    })
  }

  install(route: SshPtyOwnershipTransferPublishedRoute): void {
    const ptyId = this.toAppPtyId(route.ptyId)
    if (
      this.toRelayPtyId(ptyId) !== route.identity.terminalId ||
      route.providerGeneration !== this.providerGeneration
    ) {
      throw new Error('pty_ownership_transfer_route_identity_mismatch')
    }
    this.routes.install(Object.freeze({ ...route, ptyId }))
  }

  releaseSource(...args: Parameters<SshPtyOutgoingControlFence['release']>): void {
    this.outgoingControlFence.release(...args)
  }

  isSourceControlReleased(id: string, expectedIdentity?: unknown): boolean {
    return this.outgoingControlFence.isReleased(id, expectedIdentity)
  }

  dispose(): void {
    this.routes.dispose()
  }

  removeSourceExit(relayPtyId: string, incarnationId: unknown): void {
    if (typeof incarnationId === 'string') {
      this.routes.removeSourceExit(toAppSshPtyId(this.connectionId, relayPtyId), incarnationId)
    }
  }

  write = (id: string, data: string, retry?: PtyProviderOperationRetry): boolean => {
    if (this.outgoingControlFence.isReleased(id)) {
      return false
    }
    const routed = this.routes.write(this.toAppPtyId(id), data, retry)
    return routed ?? writeSshPty(this.mux, this.toRelayPtyId(id), data)
  }

  writeWithSettlement = (
    id: string,
    data: string,
    retry?: PtyProviderOperationRetry
  ): Promise<WriteSettlement> => {
    try {
      if (this.outgoingControlFence.isReleased(id)) {
        return Promise.resolve(writeRefused('write_gate_denied'))
      }
      const routed = this.routes.writeWithSettlement(this.toAppPtyId(id), data, retry)
      return routed
        ? settleOwnershipTransferWrite(() => routed)
        : writeSshPtyWithSettlement(this.mux, this.toRelayPtyId(id), data)
    } catch {
      return Promise.resolve(writeUnverifiable('provider_threw_after_handoff', true))
    }
  }

  retireWriteOperation = (id: string, operationId: string): Promise<boolean> => {
    return (
      this.routes.retireWriteOperation(this.toAppPtyId(id), operationId) ?? Promise.resolve(false)
    )
  }

  resize = (id: string, cols: number, rows: number, retry?: PtyProviderOperationRetry): void => {
    const routed = this.routes.control(this.toAppPtyId(id), { kind: 'resize', cols, rows }, retry)
    if (routed) {
      void routed.catch(() => undefined)
    } else {
      resizeSshPty(this.mux, this.toRelayPtyId(id), cols, rows)
    }
  }

  async shutdown(
    id: string,
    opts: {
      immediate?: boolean
      keepHistory?: boolean
      deadlineMs?: number
      operationId?: string
      expectedIncarnationId?: string
      expectedOwnerClientInstanceId?: string
    }
  ): Promise<void> {
    const ptyId = this.toAppPtyId(id)
    if (!this.routes.hasTransferred(ptyId)) {
      await shutdownSshPty(this.mux, this.toRelayPtyId(id), {
        expectedIncarnationId: opts.expectedIncarnationId,
        expectedOwnerClientInstanceId: opts.expectedOwnerClientInstanceId,
        immediate: opts.immediate,
        keepHistory: opts.keepHistory,
        timeoutMs: timeoutUntil(opts.deadlineMs)
      })
      this.livePtyIds.delete(ptyId)
      return
    }
    if (opts.keepHistory) {
      throw new Error('pty_ownership_transfer_keep_history_unsupported')
    }
    const routed = this.routes.control(
      ptyId,
      { kind: 'shutdown', immediate: opts.immediate ?? false },
      opts.deadlineMs === undefined && opts.operationId === undefined
        ? undefined
        : {
            ...(opts.deadlineMs === undefined ? {} : { timeoutMs: timeoutUntil(opts.deadlineMs)! }),
            ...(opts.operationId === undefined ? {} : { operationId: opts.operationId })
          }
    )
    if (!routed) {
      throw new Error('pty_ownership_transfer_route_unavailable')
    }
    await routed
    this.livePtyIds.delete(ptyId)
  }

  sendSignal = (id: string, signal: string, retry?: PtyProviderOperationRetry): Promise<void> => {
    const routed = this.routes.control(this.toAppPtyId(id), { kind: 'sendSignal', signal }, retry)
    return routed ?? sendSignalToSshPty(this.mux, this.toRelayPtyId(id), signal)
  }

  clearBuffer = (id: string, retry?: PtyProviderOperationRetry): Promise<void> => {
    const routed = this.routes.control(this.toAppPtyId(id), { kind: 'clearBuffer' }, retry)
    return routed ?? clearSshPtyBuffer(this.mux, this.toRelayPtyId(id))
  }

  private toRelayPtyId = (id: string): string => toRelaySshPtyId(this.connectionId, id)
  private toAppPtyId = (id: string): string => {
    this.outgoingControlFence.assertControlAllowed(id)
    return toAppSshPtyId(this.connectionId, id)
  }
}

function timeoutUntil(deadlineMs: number | undefined): number | undefined {
  return deadlineMs === undefined ? undefined : Math.max(1, deadlineMs - Date.now())
}
