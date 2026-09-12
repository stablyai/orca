import { SshPtyTransferCallerOperations } from './ssh-pty-transfer-caller-operations'
import { randomUUID } from 'node:crypto'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import type { PtyOwnershipTransferControl } from '../../shared/pty-ownership-transfer-control-wire'
import {
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import type { SshPtyOwnershipTransferClient } from './ssh-pty-ownership-transfer-client'
import type { PtyProviderOperationRetry } from './pty-provider-contract'

export type SshPtyOwnershipTransferPublishedRoute = Readonly<{
  ptyId: string
  identity: PtyOwnershipTransferWireIdentity
  attachmentId: string
  capabilities: PtyOwnershipBridgeCapabilities
  providerGeneration: number
}>

type ActiveRoute = SshPtyOwnershipTransferPublishedRoute & Readonly<{ disposeExit: () => void }>

type ControlOptions = Readonly<{
  timeoutMs?: number
  operationId?: string
}>

type RouteRegistryOptions = Readonly<{
  createOperationId?: () => string
  assertControlAllowed?: (ptyId: string) => void
  isTransportAvailable?: () => boolean
  onTransportLost?: (callback: () => void) => () => void
}>

/** Provider-generation-scoped control route installed only after durable publication. */
export class SshPtyOwnershipTransferRouteRegistry {
  private readonly activeByPtyId = new Map<string, ActiveRoute>()
  private readonly callerOperations = new SshPtyTransferCallerOperations()
  private readonly operationTails = new Map<string, Promise<void>>()
  private readonly transferredPtyIds = new Set<string>()
  private readonly createOperationId: () => string
  private readonly assertControlAllowed: (ptyId: string) => void
  private readonly isTransportAvailable: () => boolean
  private readonly disposeTransportLost: () => void

  constructor(
    private readonly client: SshPtyOwnershipTransferClient,
    private readonly providerGeneration: number,
    options: RouteRegistryOptions = {}
  ) {
    this.createOperationId = options.createOperationId ?? randomUUID
    this.assertControlAllowed = options.assertControlAllowed ?? (() => {})
    this.isTransportAvailable = options.isTransportAvailable ?? (() => true)
    this.disposeTransportLost =
      options.onTransportLost?.(() => this.clearActiveRoutes()) ?? (() => undefined)
  }

  install(route: SshPtyOwnershipTransferPublishedRoute): void {
    this.assertInstallable(route)
    const previous = this.activeByPtyId.get(route.ptyId)
    previous?.disposeExit()
    const disposeExit = this.client.onDestinationExit(route.capabilities, (event) => {
      if (
        sameRouteIdentity(route, event) &&
        event.attachmentId === route.attachmentId &&
        this.activeByPtyId.get(route.ptyId)?.attachmentId === route.attachmentId
      ) {
        this.removeActiveRoute(route.ptyId, true)
      }
    })
    this.transferredPtyIds.add(route.ptyId)
    this.activeByPtyId.set(route.ptyId, Object.freeze({ ...route, disposeExit }))
    // A replacement incarnation starts a fresh ordering lane; stale work is fenced by enqueue().
    this.operationTails.set(route.ptyId, Promise.resolve())
  }

  hasTransferred(ptyId: string): boolean {
    return this.transferredPtyIds.has(ptyId)
  }

  write(ptyId: string, data: string, retry?: PtyProviderOperationRetry): boolean | null {
    if (!this.transferredPtyIds.has(ptyId)) {
      return null
    }
    const route = this.readActiveRoute(ptyId)
    if (!route) {
      return false
    }
    const operationId = this.callerOperations.resolve(route, 'input', data, retry)
    void this.enqueue(route, () => this.sendInput(route, data, operationId)).catch(() => undefined)
    return true
  }

  writeWithSettlement(
    ptyId: string,
    data: string,
    retry?: PtyProviderOperationRetry
  ): Promise<boolean> | null {
    if (!this.transferredPtyIds.has(ptyId)) {
      return null
    }
    const route = this.readActiveRoute(ptyId)
    if (!route) {
      return Promise.resolve(false)
    }
    const operationId = this.callerOperations.resolve(route, 'input', data, retry)
    return this.enqueue(route, () => this.sendInput(route, data, operationId))
  }

  retireWriteOperation(ptyId: string, operationId: string): Promise<boolean> | null {
    if (!this.transferredPtyIds.has(ptyId)) {
      return null
    }
    const route = this.readActiveRoute(ptyId)
    if (!route) {
      return Promise.resolve(false)
    }
    const operation = this.callerOperations.read(ptyId, operationId)
    if (!operation || operation.kind !== 'input') {
      return Promise.resolve(false)
    }
    this.callerOperations.assertRoute(operation, route)
    return this.enqueue(route, async () => {
      await this.retireInput(route, operationId)
      this.callerOperations.retire(ptyId, operationId)
      return true
    })
  }

  control(
    ptyId: string,
    control: PtyOwnershipTransferControl,
    options?: ControlOptions
  ): Promise<void> | null {
    if (!this.transferredPtyIds.has(ptyId)) {
      return null
    }
    const route = this.readActiveRoute(ptyId)
    if (!route) {
      return Promise.reject(new Error('pty_ownership_transfer_route_unavailable'))
    }
    const controlId =
      this.callerOperations.resolve(
        route,
        'control',
        JSON.stringify(control),
        options?.operationId ? { operationId: options.operationId } : undefined
      ) ?? this.nextOperationId('control')
    return this.enqueue(route, async () => {
      const request = {
        ...route.identity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        attachmentId: route.attachmentId,
        controlId,
        control
      }
      let result: Awaited<ReturnType<SshPtyOwnershipTransferClient['controlDestination']>>
      const requestOptions =
        options?.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs }
      try {
        result = await this.client.controlDestination(request, route.capabilities, requestOptions)
      } catch (error) {
        if (!this.isTransportAvailable()) {
          throw error
        }
        this.assertControlAllowed(route.ptyId)
        result = await this.client.controlDestination(request, route.capabilities, requestOptions)
      }
      if (result.outcome !== 'applied') {
        throw new Error('pty_ownership_transfer_control_unverifiable')
      }
    })
  }
  removeSourceExit(ptyId: string, incarnationId: string): void {
    const route = this.activeByPtyId.get(ptyId)
    if (route?.identity.incarnationId === incarnationId) {
      this.removeActiveRoute(ptyId, true)
    }
  }

  dispose(): void {
    this.disposeTransportLost()
    this.clearActiveRoutes()
    this.callerOperations.clear()
  }

  private async sendInput(
    route: ActiveRoute,
    data: string,
    callerOperationId?: string
  ): Promise<boolean> {
    const inputId = callerOperationId ?? this.nextOperationId('input')
    const request = {
      ...route.identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      inputId,
      data
    }
    let result: Awaited<ReturnType<SshPtyOwnershipTransferClient['input']>>
    try {
      result = await this.client.input(request)
    } catch (error) {
      // A lost response is ambiguous: replay the same ID once so the destination can
      // answer from its durable deduplication record without writing bytes twice.
      if (!this.isTransportAvailable()) {
        throw error
      }
      this.assertControlAllowed(route.ptyId)
      result = await this.client.input(request)
    }
    const accepted = result.accepted || result.duplicate
    if (accepted && !callerOperationId) {
      // Keep the per-PTY lane occupied until the durable deduplication receipt is attempted.
      // A later input must not fill the remote bounded window while this ID is still retained.
      await this.retireInput(route, inputId).catch(() => undefined)
    }
    return accepted
  }

  private async retireInput(route: ActiveRoute, inputId: string): Promise<void> {
    const request = {
      ...route.identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      inputIds: [inputId]
    }
    try {
      await this.client.retireInput(request)
    } catch (error) {
      if (!this.isTransportAvailable()) {
        throw error
      }
      await this.client.retireInput(request)
    }
  }

  private enqueue<T>(route: ActiveRoute, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(route.ptyId) ?? Promise.resolve()
    const run = previous
      .then(() => {
        this.assertControlAllowed(route.ptyId)
        const active = this.activeByPtyId.get(route.ptyId)
        if (!active || active.attachmentId !== route.attachmentId) {
          throw new Error('pty_ownership_transfer_route_unavailable')
        }
        return operation()
      })
      .catch((error) => {
        // An unverifiable operation must fence the attachment; later controls cannot
        // safely overtake bytes whose destination outcome is unknown.
        if (this.activeByPtyId.get(route.ptyId)?.attachmentId === route.attachmentId) {
          this.removeActiveRoute(route.ptyId)
        }
        throw error
      })
    this.operationTails.set(
      route.ptyId,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }

  private readActiveRoute(ptyId: string): ActiveRoute | null {
    if (!this.isTransportAvailable()) {
      this.clearActiveRoutes()
      return null
    }
    return this.activeByPtyId.get(ptyId) ?? null
  }

  private assertInstallable(route: SshPtyOwnershipTransferPublishedRoute): void {
    if (
      !route.ptyId ||
      !route.attachmentId ||
      route.providerGeneration !== this.providerGeneration ||
      !route.capabilities.liveTransfer ||
      !route.capabilities.destinationOutput ||
      !route.capabilities.destinationControl ||
      !route.capabilities.authoritativeExit
    ) {
      throw new Error('pty_ownership_transfer_route_invalid')
    }
  }

  private nextOperationId(kind: 'input' | 'control'): string {
    const id = this.createOperationId()
    if (!id) {
      throw new Error(`pty_ownership_transfer_${kind}_id_invalid`)
    }
    return id
  }

  private clearActiveRoutes(): void {
    for (const route of this.activeByPtyId.values()) {
      route.disposeExit()
    }
    this.activeByPtyId.clear()
    this.operationTails.clear()
  }

  private removeActiveRoute(ptyId: string, retireCallerOperations = false): void {
    const route = this.activeByPtyId.get(ptyId)
    if (!route) {
      return
    }
    this.activeByPtyId.delete(ptyId)
    this.operationTails.delete(ptyId)
    if (retireCallerOperations) {
      this.callerOperations.delete(ptyId)
    }
    route.disposeExit()
  }
}

function sameRouteIdentity(
  route: SshPtyOwnershipTransferPublishedRoute,
  identity: PtyOwnershipTransferWireIdentity
): boolean {
  const expected = route.identity
  return (
    expected.bridgeId === identity.bridgeId &&
    expected.terminalId === identity.terminalId &&
    expected.incarnationId === identity.incarnationId &&
    expected.ownerLease === identity.ownerLease &&
    expected.sourceOwnerGeneration === identity.sourceOwnerGeneration &&
    expected.destinationRuntimeId === identity.destinationRuntimeId
  )
}
