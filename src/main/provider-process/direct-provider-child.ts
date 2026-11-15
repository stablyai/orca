import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough, Readable, Writable } from 'node:stream'
import { constants } from 'node:os'
import type { ProviderChild } from './provider-child'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import { publishProviderOwnership, providerOwnershipDirectory } from './provider-ownership-journal'
import { notifyRuntimeListeners } from '../runtime/events/runtime-listener-delivery'
import { readBootstrapStatus, withProviderBootstrapDeadline } from './provider-bootstrap-status'
import { observeProviderLeaderOutcome, type ProviderLeaderOutcome } from './provider-leader-outcome'
import {
  readProviderControlCompletion,
  type ProviderControlCompletion
} from './provider-control-completion'
import { DirectProviderStop, type ProviderControlCommand } from './direct-provider-stop'
import { drainDirectProviderOutput, pipeDirectProviderOutput } from './direct-provider-output-drain'
import { providerExecFailure, reportProviderLaunchFailure } from './provider-launch-failure'
import {
  isProviderReapSignal,
  isProviderTermSignal,
  reapDirectProviderGroup,
  signalDirectProviderGroup,
  signalDirectProviderRoot
} from './direct-provider-group-reap'

type Ownership = Awaited<ReturnType<typeof publishProviderOwnership>>

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
  writerPid?: number
  private launchedPid?: number
  private publication?: Promise<Ownership>
  private ownership?: Ownership
  private control?: Duplex
  private gate?: Writable
  private readonly releaseRaw: () => void
  private readonly stop: DirectProviderStop
  private canceled = false
  private released = false
  private outcome?: ProviderLeaderOutcome | null
  private settled = false
  private failure?: Promise<Error>
  private reapTask?: Promise<void>
  private reapAbort?: AbortController
  private nativeCompletion?: ProviderControlCompletion
  private readonly reaped: Promise<void>
  private finishReap: () => void = () => {}

  constructor(
    private readonly raw: ChildProcess,
    private readonly spec: ProviderSpawnSpec
  ) {
    super()
    this.stop = new DirectProviderStop(spec, this.send.bind(this), () => this.forceReap())
    this.stdin = raw.stdin ?? new PassThrough()
    this.reaped = new Promise((resolve) => {
      this.finishReap = resolve
    })
    const control = raw.stdio?.at(3)
    const gate = raw.stdio?.at(4)
    const status = raw.stdio?.at(5)
    this.control = control instanceof Duplex ? control : undefined
    this.gate = gate instanceof Writable ? gate : undefined
    this.stdin.on('error', () => {})
    const releaseOutput = pipeDirectProviderOutput(raw, this.stdout, this.stderr)
    if (this.control) {
      readProviderControlCompletion(this.control, (completion) => {
        this.connected = false
        this.forceReap(completion)
      })
    }
    const gateError = (): boolean => this.cancelLaunch()
    this.gate?.on('error', gateError)
    const stdinFinish = (): void => this.stdinEnded()
    this.stdin.once('finish', stdinFinish)
    const onError = (error: Error): void => {
      this.failure ??= this.reportFailure(error)
      this.cancelLaunch()
    }
    raw.once('error', onError)
    this.releaseRaw = () => {
      raw.off('error', onError)
      raw.on('error', () => {})
      this.gate?.off('error', gateError)
      this.gate?.on('error', () => {})
      this.stdin.off('finish', stdinFinish)
      releaseOutput()
    }
    void observeProviderLeaderOutcome(raw).then((outcome) => {
      this.outcome = outcome
      if (this.leaderExited) {
        this.stop.leaderExited(this.released)
      } else {
        this.forceReap()
      }
      void this.settle()
    })
    // Startup errors must be observable after callers have attached listeners.
    const bootstrap = status instanceof Readable ? readBootstrapStatus(status) : null
    this.ready = Promise.resolve()
      .then(() => withProviderBootstrapDeadline(() => this.start(bootstrap)))
      .catch(async (error) => {
        this.cancelLaunch()
        this.failure ??= this.reportFailure(error)
        throw await this.failure
      })
    void this.ready.catch(() => {})
  }

  /** Names only the CLI, once it runs; the native parent is never a provider identity. */
  get pid(): number | undefined {
    return this.launchedPid
  }
  get leaderExited(): boolean {
    return this.outcome != null && this.raw.pid !== undefined
  }

  private async start(bootstrap: ReturnType<typeof readBootstrapStatus> | null): Promise<void> {
    if (this.raw.pid === undefined) {
      if (this.failure) {
        throw await this.failure
      }
      await new Promise<never>((_resolve, reject) => this.raw.once('error', reject))
    }
    if (!bootstrap || !this.gate || !this.control || !this.raw.pid) {
      throw new Error('Provider bootstrap control pipes are unavailable')
    }
    const { leaderPid, watcherPid, bootId } = await bootstrap.initial
    this.writerPid = leaderPid
    if (this.canceled || this.outcome) {
      throw new Error('Provider launch canceled before registration')
    }
    this.publication = publishProviderOwnership(
      providerOwnershipDirectory(),
      bootId,
      leaderPid,
      watcherPid,
      this.raw.pid
    ).then(async (ownership) => {
      this.ownership = ownership
      if (this.canceled) {
        await ownership.remove()
      }
      return ownership
    })
    this.ownership = await this.publication
    if (this.canceled || this.outcome) {
      throw new Error('Provider launch canceled before execution')
    }
    bootstrap.checkGated()
    this.released = true
    this.gate.end('g\n')
    const errno = await bootstrap.ended
    if (errno !== null) {
      throw providerExecFailure(this.spec.command, errno)
    }
    if (this.canceled) {
      throw new Error('Provider bootstrap ended before launch completed')
    }
    this.launchedPid = leaderPid
    this.notify('spawn')
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.settled || this.groupVerdict === 'exited') {
      return false
    }
    if (
      !this.released &&
      signal !== 0 &&
      signal !== 'SIGSTOP' &&
      signal !== constants.signals.SIGSTOP
    ) {
      return this.cancelLaunch()
    }
    if (isProviderReapSignal(signal)) {
      return this.forceReap()
    }
    if (isProviderTermSignal(signal)) {
      return this.startTerm()
    }
    // SIGSTOP pins only the held root; stopping the watcher would disable the independent backstop.
    const delivered =
      !this.outcome &&
      this.writerPid !== undefined &&
      signalDirectProviderRoot(this.writerPid, signal)
    if (delivered && signal !== 0) {
      this.killed = true
    }
    return delivered
  }

  private cancelLaunch(): boolean {
    this.canceled = true
    this.gate?.destroy()
    return this.forceReap()
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
      this.cancelLaunch()
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
    if (!this.writerPid || this.outcome) {
      return false
    }
    return signalDirectProviderGroup(this.writerPid, signal, (delivered) => {
      this.killed ||= delivered
    })
  }

  private forceReap(completion = this.nativeCompletion): boolean {
    if (this.settled || (this.reapTask && !completion)) {
      return false
    }
    this.nativeCompletion = completion
    const gated = !this.released && !this.ownership
    if (gated) {
      this.canceled = true
      this.gate?.destroy()
      // A held bootstrap must run its gate-cancellation path to reap its unpublished watcher.
      if (this.writerPid && !this.outcome && !this.control?.destroyed) {
        signalDirectProviderRoot(this.writerPid, 'SIGCONT')
      }
    }
    if (completion || gated) {
      this.stop.complete()
      this.reapAbort?.abort()
    } else {
      this.stop.reap()
    }
    this.reapAbort = new AbortController()
    const delivered = completion || gated ? false : this.signalLiveGroup('SIGKILL')
    this.reapTask = reapDirectProviderGroup(
      delivered,
      () => this.writerPid,
      () => this.publication,
      (verdict) => {
        this.groupVerdict = this.groupVerdict === 'exited' ? 'exited' : verdict
      },
      () => {
        this.finishReap()
        if (this.groupVerdict !== 'exited' && !this.settled) {
          this.reapTask = undefined
        }
      },
      completion,
      this.reapAbort.signal
    )
    return delivered
  }

  private reportFailure(error: unknown): Promise<Error> {
    return reportProviderLaunchFailure(error, this.spec, (failure) => this.notify('error', failure))
  }

  private async settle(): Promise<void> {
    await this.ready.catch(() => {}).then(() => this.failure)
    if (this.outcome === null && !this.failure && !this.canceled) {
      this.notify(
        'error',
        new Error(`Orca lost the process outcome for ${this.spec.command}. Retry the agent.`)
      )
    }
    await this.reaped
    this.settled = true
    await drainDirectProviderOutput(this.raw.stdout, this.raw.stderr, this.stdout, this.stderr)
    this.releaseRaw()
    this.stdin.destroy()
    this.control?.destroy()
    this.gate?.destroy()
    this.connected = false
    this.exitCode = this.outcome?.code ?? null
    this.signalCode = this.outcome?.signal ?? null
    if (this.leaderExited) {
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
