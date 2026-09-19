import { randomUUID } from 'node:crypto'
import { relayLogLine } from './relay-diagnostic-log'
import type { RequestContext } from './dispatcher'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../shared/pty-ownership-transfer-identity'
import type { beginRelayPtyOwnershipCaptureBoundary } from './relay-pty-ownership-capture-boundary'
import type { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'

type Capture = ReturnType<typeof beginRelayPtyOwnershipCaptureBoundary>
type Entry = {
  token: string
  requestId: string
  identity: PtyOwnershipTransferWireIdentity
  clientId: number
  transportGeneration?: number
  principal: string
  capture: Capture
  timer: ReturnType<typeof setTimeout>
}

/** Ephemeral capture authority never survives a disconnect or relay restart. */
export class RelayPtyOwnershipCaptureRegistry {
  private readonly entries = new Map<string, Entry>()
  private disposed = false

  constructor(
    private readonly beginCapture: (
      identity: PtyOwnershipTransferWireIdentity,
      context: RequestContext
    ) => Capture,
    private readonly selectBaseline?: RelayPtyOwnershipTransferAdapter['selectCaptureBaseline']
  ) {}

  begin(
    identity: PtyOwnershipTransferWireIdentity,
    requestId: string,
    context: RequestContext
  ): string {
    this.requireContext(context)
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) {
      throw new Error('pty_ownership_capture_request_invalid')
    }
    for (const entry of this.entries.values()) {
      if (entry.clientId !== context.clientId || entry.requestId !== requestId) {
        continue
      }
      if (
        !this.matches(entry, context) ||
        !samePtyOwnershipTransferIdentity(entry.identity, identity)
      ) {
        throw new Error('pty_ownership_capture_request_conflict')
      }
      return entry.token
    }
    if (this.entries.size >= 128) {
      throw new Error('pty_ownership_capture_capacity')
    }
    const capture = this.beginCapture(identity, context)
    const token = randomUUID()
    const timer = setTimeout(() => this.removeForLifecycle(token), 5_000)
    timer.unref?.()
    this.entries.set(token, {
      token,
      requestId,
      identity: Object.freeze({ ...identity }),
      clientId: context.clientId,
      transportGeneration: context.transportGeneration,
      principal: context.sessionIdentity!.principal,
      capture,
      timer
    })
    return token
  }

  inspect(token: string, context: RequestContext) {
    return this.requireEntry(token, context).capture.inspect()
  }

  select(token: string, baseline: unknown, context: RequestContext) {
    const entry = this.requireEntry(token, context)
    if (!this.selectBaseline) {
      throw new Error('pty_ownership_capture_selection_unavailable')
    }
    return this.selectBaseline(entry.identity, baseline, () =>
      this.requireEntry(token, context).capture.inspect()
    )
  }

  release(token: string, context: RequestContext): void {
    this.requireEntry(token, context)
    this.remove(token)
  }

  detach(clientId: number): void {
    for (const entry of this.entries.values()) {
      if (entry.clientId === clientId) {
        this.removeForLifecycle(entry.token)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    for (const token of this.entries.keys()) {
      this.removeForLifecycle(token)
    }
  }

  private requireContext(context: RequestContext): void {
    if (this.disposed || context.isStale() || !context.sessionIdentity?.authenticated) {
      throw new Error('pty_ownership_capture_unavailable')
    }
  }

  private matches(entry: Entry, context: RequestContext): boolean {
    return (
      entry.clientId === context.clientId &&
      entry.transportGeneration === context.transportGeneration &&
      entry.principal === context.sessionIdentity?.principal
    )
  }

  private requireEntry(token: string, context: RequestContext): Entry {
    this.requireContext(context)
    const entry = this.entries.get(token)
    if (!entry || !this.matches(entry, context)) {
      throw new Error('pty_ownership_capture_unavailable')
    }
    return entry
  }

  private removeForLifecycle(token: string): void {
    try {
      this.remove(token)
    } catch {
      relayLogLine('pty_ownership_capture_lifecycle_release_failed')
    }
  }

  private remove(token: string): void {
    const entry = this.entries.get(token)
    if (!entry) {
      return
    }
    this.entries.delete(token)
    clearTimeout(entry.timer)
    entry.capture.release()
  }
}
