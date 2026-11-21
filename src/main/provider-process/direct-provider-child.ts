import { EventEmitter, once } from 'node:events'
import { Duplex, PassThrough, Readable, Writable } from 'node:stream'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type { ProviderChild, ProviderOwnerProcess } from './provider-child'
import { ignoreProviderTransportError, notifyProviderChild } from './provider-child'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import { publishProviderOwnership, providerOwnershipDirectory } from './provider-ownership-journal'
import { readBootstrapStatus, withProviderBootstrapDeadline } from './provider-bootstrap-status'
import { observeProviderLeaderOutcome, type ProviderLeaderOutcome } from './provider-leader-outcome'
import {
  readProviderControlCompletion,
  type ProviderControlCompletion
} from './provider-control-completion'
import { DirectProviderStop } from './direct-provider-stop'
import { drainDirectProviderOutput, pipeDirectProviderOutput } from './direct-provider-output-drain'
import { pipeDirectProviderInput } from './direct-provider-input'
import { providerExecFailure, reportProviderLaunchFailure } from './provider-launch-failure'
import { ProviderFaultOwnership } from './provider-fault-ownership'
import * as group from './direct-provider-group-reap'

export class DirectProviderChild extends EventEmitter implements ProviderChild {
  readonly ready: Promise<void>
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  connected = true
  groupVerdict: 'exited' | 'live' | 'unverifiable' = 'unverifiable'
  writerPid?: number
  pid?: number
  private publication?: Promise<Awaited<ReturnType<typeof publishProviderOwnership>>>
  private ownership?: Awaited<ReturnType<typeof publishProviderOwnership>>
  private control?: Duplex
  private gate?: Writable
  private readonly releaseRaw: () => void
  private readonly input: ReturnType<typeof pipeDirectProviderInput>
  private readonly stop: DirectProviderStop
  private canceled = false
  private released = false
  private outcome?: ProviderLeaderOutcome | null
  private readonly leaderOutcome: Promise<ProviderLeaderOutcome | null>
  private settled = false
  private failure?: Promise<Error>
  private readonly faultOwnership = new ProviderFaultOwnership()
  private reapTask?: Promise<void>
  private reapAbort?: AbortController
  private nativeCompletion?: ProviderControlCompletion
  private readonly watcherEnded = Promise.withResolvers<void>()
  private readonly reapRequested = Promise.withResolvers<void>()

  constructor(
    private readonly raw: ProviderOwnerProcess,
    private readonly spec: ProviderSpawnSpec,
    private readonly bootId: string
  ) {
    super()
    this.stop = new DirectProviderStop(spec, () => this.control, this.forceReap.bind(this))
    const [control, gate, rawStatus, , destination] = raw.stdio?.slice(3) ?? []
    const status = destination instanceof Writable ? rawStatus : null
    this.control = control instanceof Duplex ? control : undefined
    this.gate = gate instanceof Writable ? gate : undefined
    this.input = pipeDirectProviderInput(
      destination instanceof Writable ? destination : undefined,
      this.stdin,
      () => this.stdinEnded(),
      () => this.faultOwnership.stop('stdin', this.input.end)
    )
    const releaseOutput = pipeDirectProviderOutput(raw, this.stdout, this.stderr)
    if (this.control) {
      readProviderControlCompletion(this.control, (completion) => {
        this.connected = false
        this.transportEnded(completion)
        this.watcherEnded.resolve()
      })
    } else {
      this.watcherEnded.resolve()
    }
    const gateError = (): boolean => this.cancelLaunch()
    this.gate?.on('error', gateError)
    const onError = (error: Error): void => {
      this.failure ??= this.reportFailure(error)
      this.cancelLaunch()
    }
    raw.once('error', onError)
    this.releaseRaw = () => {
      raw.off('error', onError).on('error', ignoreProviderTransportError)
      this.gate?.off('error', gateError).on('error', ignoreProviderTransportError)
      this.input.release()
      releaseOutput()
    }
    this.leaderOutcome = observeProviderLeaderOutcome(raw)
    void this.leaderOutcome.then((outcome) => {
      this.outcome = outcome
      if (outcome !== null) {
        // P's outcome ends input ownership even while H is still retiring adopted children.
        this.input.release()
      }
      if (this.leaderExited && this.connected) {
        this.stop.leaderExited(this.released)
      } else if (this.leaderExited || this.connected) {
        // A lost watcher already started the ladder that a lost parent would.
        this.transportEnded()
      }
      void this.settle()
    })
    const bootstrap = status instanceof Readable ? readBootstrapStatus(status) : null
    this.ready = withProviderBootstrapDeadline(() => this.start(bootstrap)).catch(async (error) => {
      this.cancelLaunch()
      this.failure ??= this.reportFailure(error)
      throw await this.failure
    })
    void this.ready.catch(() => {})
  }

  /** The native owner wrapping the CLI; on Linux it also adopts what the CLI backgrounds. */
  get ownerPid(): number | undefined {
    return this.raw.pid
  }

  get leaderExited(): boolean {
    return (
      this.raw.pid !== undefined &&
      (this.outcome != null || (this.writerPid !== undefined && this.groupVerdict === 'exited'))
    )
  }

  get outcomeLost(): boolean {
    return this.outcome === null && this.pid !== undefined && !this.failure
  }

  get numericIdentityRetired(): boolean {
    return this.settled || this.outcome !== undefined || this.groupVerdict === 'exited'
  }

  private async start(bootstrap: ReturnType<typeof readBootstrapStatus> | null): Promise<void> {
    if (this.raw.pid === undefined) {
      // A hosted launch reports its PID later; a failed spawn rejects with its error.
      await once(this.raw, 'spawn').catch(async (error: Error) => {
        throw await (this.failure ?? error)
      })
    }
    if (!bootstrap || !this.gate || !this.control || !this.raw.pid) {
      throw new Error('Provider bootstrap control pipes are unavailable')
    }
    const { leaderPid, watcherPid } = await bootstrap.initial
    this.writerPid = leaderPid
    if (this.canceled || this.outcome !== undefined) {
      throw new Error('Provider launch canceled before registration')
    }
    this.publication = publishProviderOwnership(
      providerOwnershipDirectory(),
      this.bootId,
      leaderPid,
      watcherPid,
      this.raw.pid
    )
    this.ownership = await this.publication
    if (this.canceled) {
      await this.ownership.remove()
    }
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
    this.pid = leaderPid
    notifyProviderChild(this, 'spawn')
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.settled || this.groupVerdict === 'exited') {
      return false
    }
    if (!this.released && !group.isProviderProbeOrPause(signal)) {
      return this.cancelLaunch()
    }
    if (group.isProviderReapSignal(signal)) {
      return this.forceReap()
    }
    if (group.isProviderTermSignal(signal)) {
      return this.startTerm()
    }
    return group.signalLiveDirectProviderRoot(this, signal)
  }

  private cancelLaunch(): boolean {
    this.canceled = true
    this.gate?.destroy()
    return this.forceReap()
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

  private startTerm(resend = false): boolean {
    if (this.faultOwnership.deferStop('term', () => this.startTerm(resend))) {
      return false
    }
    if (this.stop.reaping || (!this.stop.term() && !resend)) {
      return false
    }
    const watcherConnected = this.connected && this.control?.writable && !this.control.destroyed
    // The watcher sends TERM once; queueing control is not proof of signal delivery.
    return watcherConnected ? false : group.signalDirectProviderGroup(this, 'SIGTERM')
  }

  private transportEnded(completion?: ProviderControlCompletion): void {
    if (this.settled || !this.released || this.outcome != null) {
      this.forceReap(completion)
      return
    }
    this.faultOwnership.stopAfterCapture(
      this.publication,
      () => {
        if (completion || this.stop.reaping || this.leaderExited) {
          this.forceReap(completion)
        } else if (!this.settled) {
          this.input.end()
          this.stop.ownerLost(this.connected, () => this.startTerm(true))
        }
      },
      completion ? this.leaderOutcome.then((outcome) => outcome !== null) : undefined
    )
  }

  private forceReap(completion = this.nativeCompletion): boolean {
    if (this.settled || (this.reapTask && !completion)) {
      return false
    }
    if (this.faultOwnership.deferStop('reap', () => this.forceReap(completion))) {
      return false
    }
    this.nativeCompletion = completion
    const gated = !this.released && !this.ownership
    if (gated) {
      this.canceled = true
      this.gate?.destroy()
      // A held bootstrap must run its gate-cancellation path to reap its unpublished watcher.
      if (this.writerPid && this.outcome === undefined && !this.control?.destroyed) {
        group.signalDirectProviderRoot(this.writerPid, 'SIGCONT')
      }
    }
    if (completion || gated) {
      this.stop.complete()
      this.reapAbort?.abort()
    } else {
      this.stop.reap()
    }
    this.reapAbort = new AbortController()
    const delivered = completion || gated ? false : group.signalDirectProviderGroup(this, 'SIGKILL')
    this.reapTask = group.reapDirectProviderGroup(
      delivered,
      () => this.writerPid,
      () => this.publication,
      (verdict) => {
        this.groupVerdict = this.groupVerdict === 'exited' ? 'exited' : verdict
      },
      () => this.faultOwnership.descendantsCleaned(),
      completion,
      this.reapAbort.signal
    )
    this.reapRequested.resolve()
    return delivered
  }

  private reportFailure(error: unknown): Promise<Error> {
    const notify = (failure: Error): void => notifyProviderChild(this, 'error', failure)
    return reportProviderLaunchFailure(error, this.spec, notify)
  }

  private async settle(): Promise<void> {
    await this.ready.catch(() => {}).then(() => this.failure)
    await this.faultOwnership.task
    // Keep W's proof channel through retirement; overlap its bound with the existing ladder.
    const watcherRetirement =
      this.outcome === null &&
      this.connected &&
      withTimeout(this.watcherEnded.promise, this.stop.maxStopMs, undefined)
    await group.joinCurrentProviderReap(() => this.reapTask)
    if (this.raw.pid !== undefined && this.groupVerdict !== 'exited') {
      const ladder = this.outcome === null ? this.reapRequested : this.watcherEnded
      await withTimeout(ladder.promise, this.stop.maxStopMs, undefined)
    }
    if (this.outcome === null) {
      // The owner-death ladder is spent; its group still owes the validated reap.
      this.forceReap()
    }
    await watcherRetirement
    await group.joinCurrentProviderReap(() => this.reapTask)
    await drainDirectProviderOutput(this.raw.stdout, this.raw.stderr, this.stdout, this.stderr)
    await group.joinCurrentProviderReap(() => this.reapTask)
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
