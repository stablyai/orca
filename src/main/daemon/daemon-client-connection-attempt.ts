import type { Duplex } from 'node:stream'
import {
  awaitDaemonTransport,
  destroyDaemonTransport,
  type DaemonClientTransport
} from './daemon-client-transport'
import { DaemonProtocolError } from './types'

export class DaemonConnectionAttempt {
  readonly controller = new AbortController()
  private deadline: number
  readonly readerCleanups: (() => void)[] = []
  releaseReaders(): void {
    for (const cleanup of this.readerCleanups.splice(0)) {
      cleanup()
    }
  }
  private guards: (() => void)[] = []
  constructor(
    private transport: DaemonClientTransport,
    private timeoutMs: number,
    private sharedBudget: boolean
  ) {
    this.deadline = Date.now() + timeoutMs
  }
  remainingMs(): number {
    return this.sharedBudget ? Math.max(1, this.deadline - Date.now()) : this.timeoutMs
  }
  wait<T>(run: (signal: AbortSignal) => T | Promise<T>, late?: (value: T) => void): Promise<T> {
    return awaitDaemonTransport(
      run,
      { timeoutMs: this.remainingMs(), signal: this.controller.signal },
      late
    )
  }
  readToken(): Promise<string> {
    return this.wait((signal) =>
      this.transport.readToken({ timeoutMs: this.remainingMs(), signal })
    )
  }
  async connect(role: 'control' | 'stream'): Promise<Duplex> {
    const stream = await this.wait(
      (signal) => this.transport.connect(role, { timeoutMs: this.remainingMs(), signal }),
      destroyDaemonTransport
    )
    const fail = (): void => {
      queueMicrotask(() =>
        this.controller.abort(new DaemonProtocolError('Connection closed during setup'))
      )
    }
    stream.on('error', fail)
    stream.on('close', fail)
    this.guards.push(() => {
      stream.off('error', fail)
      stream.off('close', fail)
    })
    if (stream.destroyed || !stream.readable || !stream.writable) {
      fail()
    }
    return stream
  }
  releaseGuards(): void {
    for (const cleanup of this.guards.splice(0)) {
      cleanup()
    }
  }
}
