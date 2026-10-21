import { randomUUID } from 'node:crypto'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import {
  isTerminalSubscriptionId,
  isTerminalTransientObservation,
  type TerminalTransientCurrent
} from '../../shared/terminal-transient-observation'
import type { DaemonEvent, TerminalObservationEvent } from './daemon-stream-events'

type Binding = {
  subscriptionId: string
  incarnationId: string
  sessionId: string | null
  epoch: number
  revision: number
  rawEndSeq: number
  confirmed: boolean
  current: TerminalTransientCurrent | null
}

/** Ordered host installs replace physical bindings; pending RPCs own no reader rows. */
export class DaemonTransientReader {
  private readonly bindings = new Map<string, Binding>()
  private readonly subscriptions = new Map<string, Binding>()
  private readonly sessions = new Map<string, Binding>()
  private retainedBytes = 4096
  private disposed = false
  constructor(
    readonly streamId: string,
    private readonly emit: (event: DaemonEvent) => void,
    private readonly resolveSession: (incarnationId: string) => string | undefined = () => undefined
  ) {}

  begin(): { streamId: string; subscriptionId: string } {
    return { streamId: this.streamId, subscriptionId: randomUUID() }
  }

  retained(): { bytes: number; bindings: number } {
    return { bytes: this.retainedBytes, bindings: this.bindings.size }
  }

  // Includes indexes, current scalar state and bounded identity strings; canonical keys are shared with the owner.
  private charge(binding: Binding): number {
    return 512 + 2 * (binding.incarnationId.length + binding.subscriptionId.length)
  }

  private remove(binding: Binding): void {
    this.bindings.delete(binding.incarnationId)
    this.subscriptions.delete(binding.subscriptionId)
    if (binding.sessionId && this.sessions.get(binding.sessionId) === binding) {
      this.sessions.delete(binding.sessionId)
    }
    this.retainedBytes -= this.charge(binding)
  }

  detach(sessionId: string): void {
    const binding = this.sessions.get(sessionId)
    if (binding) {
      this.remove(binding)
    }
  }

  dispose(): void {
    this.disposed = true
    this.bindings.clear()
    this.subscriptions.clear()
    this.sessions.clear()
    this.retainedBytes = 4096
  }

  finish(subscriptionId: string, result: unknown): void {
    if (this.disposed) {
      return
    }
    const installed = this.subscriptions.get(subscriptionId)
    if (!result || typeof result !== 'object' || !('transients' in result)) {
      return
    }
    const echo = result.transients
    if (
      !echo ||
      typeof echo !== 'object' ||
      !('streamId' in echo) ||
      echo.streamId !== this.streamId ||
      !('subscriptionId' in echo) ||
      echo.subscriptionId !== subscriptionId ||
      !('incarnationId' in result) ||
      !isPtyIncarnationId(result.incarnationId) ||
      !('sessionId' in echo) ||
      typeof echo.sessionId !== 'string' ||
      (installed && installed.incarnationId !== result.incarnationId)
    ) {
      if (installed) {
        installed.confirmed = false
        installed.current = null
      }
      return
    }
    // A result cannot create a placeholder or resurrect an exited/detached incarnation.
    this.confirm(echo.sessionId, result.incarnationId)
  }

  confirm(sessionId: string, incarnationId: string): void {
    const binding = this.bindings.get(incarnationId)
    if (binding) {
      this.mapSession(binding, sessionId)
    }
  }

  private mapSession(binding: Binding, sessionId: string): void {
    if (binding.sessionId !== null && binding.sessionId !== sessionId) {
      binding.confirmed = false
      binding.current = null
      return
    }
    binding.sessionId = sessionId
    const previous = this.sessions.get(sessionId)
    if (previous && previous !== binding) {
      this.remove(previous)
    }
    this.sessions.set(sessionId, binding)
    if (binding.current && binding.confirmed) {
      this.emit({
        type: 'event',
        event: 'terminalObservation',
        sessionId,
        streamId: this.streamId,
        subscriptionId: binding.subscriptionId,
        incarnationId: binding.incarnationId,
        epoch: binding.epoch,
        payload: {
          kind: 'install',
          revision: binding.revision,
          rawEndSeq: binding.rawEndSeq,
          current: binding.current
        }
      })
      binding.current = null
    }
  }

  accept(event: DaemonEvent): void {
    if (this.disposed) {
      return
    }
    if (event.event === 'terminalObservation') {
      this.observe(event)
      return
    }
    if (event.event === 'data' || event.event === 'dataGap') {
      const subscriptionId = event.payload.subscriptionId
      const binding = subscriptionId ? this.subscriptions.get(subscriptionId) : undefined
      if (binding) {
        this.mapSession(binding, event.sessionId)
      }
      if (
        subscriptionId &&
        event.event === 'data' &&
        event.payload.data === '' &&
        event.payload.rawLength === 0
      ) {
        return
      }
    }
    if (event.event === 'exit') {
      const binding = event.payload.incarnationId
        ? this.bindings.get(event.payload.incarnationId)
        : undefined
      if (binding) {
        this.remove(binding)
      }
    }
    this.emit(event)
  }

  private observe(event: TerminalObservationEvent): void {
    if (
      event.streamId !== this.streamId ||
      !isTerminalSubscriptionId(event.subscriptionId) ||
      !isPtyIncarnationId(event.incarnationId) ||
      !Number.isSafeInteger(event.epoch) ||
      event.epoch < 0 ||
      !isTerminalTransientObservation(event.payload)
    ) {
      return
    }
    const payload = event.payload
    let binding = this.bindings.get(event.incarnationId)
    if (payload.kind === 'install') {
      const same = binding?.subscriptionId === event.subscriptionId
      if (
        binding &&
        (payload.rawEndSeq < binding.rawEndSeq ||
          payload.revision < binding.revision ||
          (same &&
            (event.epoch < binding.epoch ||
              (event.epoch === binding.epoch && payload.revision === binding.revision))))
      ) {
        return
      }
      if (!binding) {
        const bytes = 512 + 2 * (event.incarnationId.length + event.subscriptionId.length)
        if (this.bindings.size >= 4096 || this.retainedBytes + bytes > 4 * 1024 * 1024) {
          return
        }
        binding = {
          incarnationId: event.incarnationId,
          subscriptionId: event.subscriptionId,
          sessionId: null,
          epoch: -1,
          revision: -1,
          rawEndSeq: 0,
          confirmed: false,
          current: null
        }
        this.bindings.set(event.incarnationId, binding)
        this.retainedBytes += bytes
      } else {
        this.subscriptions.delete(binding.subscriptionId)
        binding.subscriptionId = event.subscriptionId
      }
      this.subscriptions.set(event.subscriptionId, binding)
      binding.epoch = event.epoch
      binding.revision = payload.revision
      binding.rawEndSeq = payload.rawEndSeq
      binding.confirmed = true
      const current = payload.current
      binding.current = {
        command: current.command,
        commandRevision: current.commandRevision,
        mode2031: current.mode2031,
        modeRevision: current.modeRevision
      }
      const sessionId = binding.sessionId ?? this.resolveSession(event.incarnationId)
      if (sessionId !== undefined && sessionId !== null) {
        this.mapSession(binding, sessionId)
      }
      return
    }
    if (!binding || binding.subscriptionId !== event.subscriptionId) {
      return
    }
    if (
      !binding.confirmed ||
      event.epoch !== binding.epoch ||
      payload.revision !== binding.revision + 1 ||
      payload.rawEndSeq < binding.rawEndSeq ||
      binding.sessionId === null
    ) {
      binding.confirmed = false
      binding.current = null
      return
    }
    binding.revision = payload.revision
    binding.rawEndSeq = payload.rawEndSeq
    this.emit({ ...event, sessionId: binding.sessionId })
  }
}
