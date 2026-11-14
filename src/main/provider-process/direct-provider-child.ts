import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough, Readable, Writable } from 'node:stream'
import { constants } from 'node:os'
import type { ProviderChild } from './provider-child'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import { publishProviderOwnership, providerOwnershipDirectory } from './provider-ownership-journal'
import { notifyRuntimeListeners } from '../runtime/events/runtime-listener-delivery'
import { readBootstrapStatus } from './provider-bootstrap-status'
import { DirectProviderStop, type ProviderControlCommand } from './direct-provider-stop'
import { drainDirectProviderOutput } from './direct-provider-output-drain'
import { providerExecFailure, reportProviderLaunchFailure } from './provider-launch-failure'
import {
  isProviderReapSignal,
  isProviderTermSignal,
  reapDirectProviderGroup,
  signalDirectProviderGroup
} from './direct-provider-group-reap'

type Outcome = { code: number | null; signal: NodeJS.Signals | null }
type Ownership = Awaited<ReturnType<typeof publishProviderOwnership>>
const START_TIMEOUT_MS = 15_000

/** Holds the actual CLI streams/outcome while group cleanup and drain settle independently. */
export class DirectProviderChild extends EventEmitter implements ProviderChild {
  readonly ready: Promise<void>
  readonly spawnAbsenceKnown = true
  readonly stdin: Writable
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  connected = true
  groupVerdict: 'exited' | 'live' | 'unverifiable' = 'unverifiable'
  private ownership?: Ownership
  private control?: Duplex
  private gate?: Writable
  private readonly stop: DirectProviderStop
  private canceled = false
  private released = false
  private outcome?: Outcome
  private settled = false
  private failure?: Promise<Error>
  private reapTask?: Promise<void>
  private readonly reaped: Promise<void>
  private finishReap: () => void = () => {}

  constructor(
    private readonly raw: ChildProcess,
    private readonly spec: ProviderSpawnSpec
  ) {
    super()
    this.stop = new DirectProviderStop(
      spec,
      (command) => this.send(command),
      () => this.forceReap()
    )
    this.stdin = raw.stdin ?? new PassThrough()
    this.reaped = new Promise((resolve) => {
      this.finishReap = resolve
    })
    const control = raw.stdio?.at(3)
    const gate = raw.stdio?.at(4)
    const status = raw.stdio?.at(5)
    if (control instanceof Duplex) {
      this.control = control
    }
    if (gate instanceof Writable) {
      this.gate = gate
    }
    this.stdin.on('error', () => {})
    raw.stdout?.on('error', (error) => this.stdout.destroy(error))
    raw.stderr?.on('error', (error) => this.stderr.destroy(error))
    this.stdout.on('error', () => {})
    this.stderr.on('error', () => {})
    // Keep EOF behind settlement, as well as exit, so protocol peers cannot fail during group cleanup.
    raw.stdout?.pipe(this.stdout, { end: false })
    raw.stderr?.pipe(this.stderr, { end: false })
    const watcherGone = (): void => {
      this.connected = false
      if (!this.stop.reaping && !this.settled) {
        this.forceReap()
      }
    }
    this.control?.once('end', watcherGone)
    this.control?.once('close', watcherGone)
    this.control?.on('error', watcherGone)
    this.control?.resume()
    this.gate?.on('error', () => {
      this.canceled = true
      this.forceReap()
    })
    this.stdin.once('finish', () => this.stdinEnded())
    raw.once('error', (error) => {
      this.failure ??= this.reportFailure(error)
      this.canceled = true
      this.gate?.destroy()
      this.forceReap()
    })
    raw.once('exit', (code, signal) => {
      this.outcome = { code, signal }
      this.stop.leaderExited(this.released)
      void this.settle(false)
    })
    raw.once('close', (code, signal) => {
      if (raw.pid === undefined) {
        this.outcome = { code, signal }
        this.forceReap()
        void this.settle(true)
      }
    })
    // Startup errors must be observable after callers have attached listeners.
    const bootstrap = status instanceof Readable ? readBootstrapStatus(status) : null
    this.ready = Promise.resolve().then(async () => {
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          this.start(bootstrap),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Provider ownership startup timed out')),
              START_TIMEOUT_MS
            )
          })
        ])
      } catch (error) {
        this.canceled = true
        this.gate?.destroy()
        this.forceReap()
        this.failure ??= this.reportFailure(error)
        throw await this.failure
      } finally {
        clearTimeout(timer)
      }
    })
    void this.ready.catch(() => {})
  }

  get pid(): number | undefined {
    return this.raw.pid
  }
  get leaderExited(): boolean {
    return this.outcome !== undefined && this.raw.pid !== undefined
  }
  get rootAbsent(): boolean {
    return this.raw.pid === undefined && this.settled
  }

  private async start(bootstrap: ReturnType<typeof readBootstrapStatus> | null): Promise<void> {
    if (this.pid === undefined) {
      if (this.failure) {
        throw await this.failure
      }
      await new Promise<never>((_resolve, reject) => this.raw.once('error', reject))
    }
    if (!bootstrap || !this.gate || !this.control || !this.pid) {
      throw new Error('Provider bootstrap control pipes are unavailable')
    }
    const { watcherPid, bootId } = await bootstrap.initial
    if (this.canceled || this.outcome) {
      throw new Error('Provider launch canceled before registration')
    }
    this.ownership = await publishProviderOwnership(
      providerOwnershipDirectory(),
      bootId,
      this.pid,
      watcherPid
    )
    if (this.canceled || this.outcome) {
      await this.ownership.remove()
      throw new Error('Provider launch canceled before execution')
    }
    bootstrap.checkGated()
    this.released = true
    this.gate.end('g\n')
    const errno = await bootstrap.ended
    if (errno !== null) {
      throw providerExecFailure(this.spec.command, errno)
    }
    if (this.canceled || this.leaderOutcome()?.signal) {
      throw new Error('Provider bootstrap ended before launch completed')
    }
    this.notify('spawn')
  }

  private leaderOutcome(): Outcome | undefined {
    return this.outcome
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.settled) {
      return false
    }
    if (
      !this.released &&
      signal !== 0 &&
      signal !== 'SIGSTOP' &&
      signal !== constants.signals.SIGSTOP
    ) {
      this.canceled = true
      this.gate?.destroy()
      return this.forceReap()
    }
    if (isProviderReapSignal(signal)) {
      return this.forceReap()
    }
    if (isProviderTermSignal(signal)) {
      return this.startTerm()
    }
    // SIGSTOP pins only the held root; stopping the watcher would disable the independent backstop.
    const delivered = this.outcome ? false : this.raw.kill(signal)
    if (delivered && signal !== 0) {
      this.killed = true
    }
    return delivered
  }

  private send(command: ProviderControlCommand): void {
    if (!this.control?.destroyed && this.control?.writable) {
      this.control.write(`${command}\n`)
    }
  }

  private stdinEnded(): void {
    if (!this.stop.canEndStdin || this.settled) {
      return
    }
    if (!this.released) {
      this.canceled = true
      this.gate?.destroy()
      this.forceReap()
      return
    }
    this.stop.stdinEnded()
  }

  private startTerm(): boolean {
    if (!this.stop.term()) {
      return false
    }
    const watcherConnected = this.control?.writable && !this.control.destroyed
    // The watcher sends TERM once; queueing control is not proof of signal delivery.
    return watcherConnected ? false : this.signalLiveGroup('SIGTERM')
  }

  private signalLiveGroup(signal: NodeJS.Signals): boolean {
    if (!this.pid || this.outcome) {
      return false
    }
    return signalDirectProviderGroup(this.raw, this.pid, signal, (delivered) => {
      this.killed ||= delivered
    })
  }

  private forceReap(): boolean {
    if (this.reapTask) {
      return false
    }
    this.stop.reap()
    const delivered = this.signalLiveGroup('SIGKILL')
    this.reapTask = reapDirectProviderGroup(
      delivered,
      () => this.pid,
      () => this.ownership,
      (verdict) => {
        this.groupVerdict = verdict
      },
      () => {
        this.finishReap()
        if (this.groupVerdict !== 'exited' && !this.settled) {
          this.reapTask = undefined
        }
      }
    )
    return delivered
  }

  private reportFailure(error: unknown): Promise<Error> {
    return reportProviderLaunchFailure(error, this.spec, (failure) => this.notify('error', failure))
  }

  private async settle(processless: boolean): Promise<void> {
    if (this.settled) {
      return
    }
    await this.ready.catch(() => {})
    await this.failure
    await this.reaped
    if (this.settled || !this.outcome) {
      return
    }
    this.settled = true
    await drainDirectProviderOutput(this.raw.stdout, this.raw.stderr, this.stdout, this.stderr)
    this.stdin.destroy()
    this.control?.destroy()
    this.gate?.destroy()
    this.connected = false
    this.exitCode = this.outcome.code
    this.signalCode = this.outcome.signal
    if (!processless) {
      this.notify('exit', this.exitCode, this.signalCode)
    }
    this.notify('close', this.exitCode, this.signalCode)
  }

  private notify(event: string, ...args: unknown[]): void {
    notifyRuntimeListeners(
      this.rawListeners(event),
      (listener) => listener.apply(this, args),
      `provider ${event}`
    )
  }
}
