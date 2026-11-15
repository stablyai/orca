import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough, Readable, Writable } from 'node:stream'
import { constants } from 'node:os'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { ProviderChild } from './provider-child'
import { ignoreProviderTransportError, notifyProviderChild } from './provider-child'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import { publishProviderOwnership, providerOwnershipDirectory } from './provider-ownership-journal'
import { readBootstrapStatus, withProviderBootstrapDeadline } from './provider-bootstrap-status'
import { observeProviderLeaderOutcome, type ProviderLeaderOutcome } from './provider-leader-outcome'
import {
  readProviderControlCompletion,
  type ProviderControlCompletion
} from './provider-control-completion'
import { DirectProviderStop, type ProviderControlCommand } from './direct-provider-stop'
import { drainDirectProviderOutput, pipeDirectProviderOutput } from './direct-provider-output-drain'
import { pipeDirectProviderInput } from './direct-provider-input'
import { providerExecFailure, reportProviderLaunchFailure } from './provider-launch-failure'
import {
  joinCurrentProviderReap,
  isProviderReapSignal,
  isProviderTermSignal,
  reapDirectProviderGroup,
  signalDirectProviderGroup,
  signalDirectProviderRoot
} from './direct-provider-group-reap'

type Ownership = Awaited<ReturnType<typeof publishProviderOwnership>>

export class DirectProviderChild extends EventEmitter implements ProviderChild {
  readonly ready: Promise<void>
  readonly spawnAbsenceKnown = true
  readonly stdin = new PassThrough()
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
  private readonly watcherEnded: Promise<void>

  constructor(
    private readonly raw: ChildProcess,
    private readonly spec: ProviderSpawnSpec
  ) {
    super()
    this.stop = new DirectProviderStop(spec, this.send.bind(this), () => this.forceReap())
    let watcherEnded = (): void => {}
    this.watcherEnded = new Promise((resolve) => {
      watcherEnded = resolve
    })
    const control = raw.stdio?.at(3)
    const gate = raw.stdio?.at(4)
    const status = raw.stdio?.at(5)
    this.control = control instanceof Duplex ? control : undefined
    this.gate = gate instanceof Writable ? gate : undefined
    const releaseInput = pipeDirectProviderInput(raw, this.stdin, () => this.stdinEnded())
    const releaseOutput = pipeDirectProviderOutput(raw, this.stdout, this.stderr)
    if (this.control) {
      readProviderControlCompletion(this.control, (completion) => {
        this.connected = false
        this.forceReap(completion)
        watcherEnded()
      })
    } else {
      watcherEnded()
    }
    const gateError = (): boolean => this.cancelLaunch()
    this.gate?.on('error', gateError)
    const onError = (error: Error): void => {
      this.failure ??= this.reportFailure(error)
      this.cancelLaunch()
    }
    raw.once('error', onError)
    this.releaseRaw = () => {
      raw.off('error', onError)
      raw.on('error', ignoreProviderTransportError)
      this.gate?.off('error', gateError)
      this.gate?.on('error', ignoreProviderTransportError)
      releaseInput()
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

  get pid(): number | undefined {
    return this.launchedPid
  }
  get leaderExited(): boolean {
    return (
      this.raw.pid !== undefined &&
      (this.outcome != null || (this.writerPid !== undefined && this.groupVerdict === 'exited'))
    )
  }

  get numericIdentityRetired(): boolean {
    return this.settled || this.outcome !== undefined || this.groupVerdict === 'exited'
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
    if (this.canceled || this.outcome !== undefined) {
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
    if (this.canceled || this.outcome !== undefined) {
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
    notifyProviderChild(this, 'spawn')
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
      this.outcome === undefined &&
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
    if (!this.writerPid || this.numericIdentityRetired) {
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
      if (this.writerPid && this.outcome === undefined && !this.control?.destroyed) {
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
      completion,
      this.reapAbort.signal
    )
    return delivered
  }

  private reportFailure(error: unknown): Promise<Error> {
    return reportProviderLaunchFailure(error, this.spec, (failure) =>
      notifyProviderChild(this, 'error', failure)
    )
  }

  private async settle(): Promise<void> {
    await this.ready.catch(() => {}).then(() => this.failure)
    if (this.outcome === null && !this.failure && !this.canceled) {
      notifyProviderChild(this, 'error', new Error('The agent stopped unexpectedly. Try again.'))
    }
    await joinCurrentProviderReap(() => this.reapTask)
    if (this.raw.pid !== undefined && this.groupVerdict !== 'exited' && this.connected) {
      await withTimeout(this.watcherEnded, this.stop.maxStopMs, undefined)
    }
    await joinCurrentProviderReap(() => this.reapTask)
    await drainDirectProviderOutput(this.raw.stdout, this.raw.stderr, this.stdout, this.stderr)
    await joinCurrentProviderReap(() => this.reapTask)
    this.settled = true
    this.releaseRaw()
    this.stdin.destroy()
    this.control?.destroy()
    this.gate?.destroy()
    this.connected = false
    this.exitCode = this.outcome?.code ?? null
    this.signalCode = this.outcome?.signal ?? null
    if (this.leaderExited) {
      notifyProviderChild(this, 'exit', this.exitCode, this.signalCode)
    }
    notifyProviderChild(this, 'close', this.exitCode, this.signalCode)
  }
}
