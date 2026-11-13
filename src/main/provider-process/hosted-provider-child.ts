import { AsyncLocalStorage } from 'node:async_hooks'
import { retainProviderOutput } from './provider-output-handoff'
import {
  observeHostedProviderExit,
  probeHostedProviderRoot,
  queryHostedProviderState
} from './hosted-provider-exit-observer'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { HostedProviderOutcome } from '../daemon/protocol/daemon-provider-process-protocol'
import { ProviderOwnerListener, watchProviderControl } from './provider-owner-channels'
import { ProviderChildHandle } from './provider-child-handle'
import type { createProviderSpawnSpec } from './provider-process-supervisor'
import { sameDaemonIdentity } from '../daemon/transport/client/daemon-client-hello-handshake'
import {
  createHostedLaunch,
  inspectHostedIdentity,
  withProviderStartDeadline
} from './hosted-provider-launch'

type ProviderSpawnSpec = ReturnType<typeof createProviderSpawnSpec>
const START_TIMEOUT_MS = 10_000
const EXIT_PROOF_TIMEOUT_MS = 8_000
const RPC_TIMEOUT_MS = 1_000
const observationNotifications = new AsyncLocalStorage<HostedProviderChild>()

/** Streams exist before a remote spawn; only the owning host may supply its PID and exit. */
export class HostedProviderChild extends ProviderChildHandle {
  private readonly listener = new ProviderOwnerListener()
  private client: DaemonClient | null = null
  private dispatched = false
  private canceled = false
  private observation: { connecting: boolean } | null = null
  private observationPending = false
  private removeEvents: () => void = () => {}
  private removeDisconnect: () => void = () => {}

  constructor(
    private readonly spec: ProviderSpawnSpec,
    getHost: () => Promise<DaemonClient | null>,
    private readonly fallback: () => ChildProcessWithoutNullStreams
  ) {
    super()
    // Defer errors until the caller can install its observation/ownership listeners.
    queueMicrotask(() => void this.launch(getHost))
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.direct) {
      const delivered = this.direct.kill(signal)
      this.killed = this.direct.killed
      return delivered
    }
    if (typeof signal !== 'string' || this.settled) {
      return false
    }
    this.killed = true
    void this.signalHeldRoot(signal).catch(() => {})
    // SDK kill means queued intent; Orca's proof callers await signalRoot instead.
    return true
  }

  get signalRoot(): ((signal: NodeJS.Signals) => Promise<boolean>) | undefined {
    return this.direct ? undefined : (signal) => this.signalHeldRoot(signal)
  }

  private async signalHeldRoot(signal: NodeJS.Signals): Promise<boolean> {
    const fromObservationFailure = observationNotifications.getStore() === this
    if (this.direct) {
      return this.direct.kill(signal)
    }
    if (!this.pid) {
      this.canceled = true
      if (!this.dispatched) {
        this.failBeforeDispatch(new Error('Provider launch canceled'))
        return false
      }
      await this.listener.close()
    }
    if (!this.client || !this.dispatched || this.settled) {
      return false
    }
    try {
      const result = await this.client.request<{ delivered: boolean }>(
        'signalProvider',
        { nonce: this.listener.nonce, signal },
        RPC_TIMEOUT_MS
      )
      return result.delivered === true
    } catch {
      if (!fromObservationFailure) {
        void this.observeLostHost()
      }
      return false
    }
  }

  private async launch(getHost: () => Promise<DaemonClient | null>): Promise<void> {
    try {
      this.client = await getHost()
      if (this.canceled) {
        return this.failBeforeDispatch(new Error('Provider launch canceled'))
      }
      if (!this.client) {
        return this.launchDirect()
      }
      const path = await this.listener.listen()
      if (this.canceled) {
        return this.failBeforeDispatch(new Error('Provider launch canceled'))
      }
      const identity = await inspectHostedIdentity(this.client)
      if (this.canceled) {
        return this.failBeforeDispatch(new Error('Provider launch canceled'))
      }
      const currentIdentity = this.client.getDaemonIdentity()
      if (
        !identity ||
        !currentIdentity?.providerSpawn ||
        !sameDaemonIdentity(identity, currentIdentity)
      ) {
        return this.launchDirect()
      }
      const payload = createHostedLaunch(this.spec, identity.pid, {
        path,
        nonce: this.listener.nonce
      })
      this.removeEvents = this.client.onProviderExit(
        this.listener.nonce,
        (outcome) => this.observeOutcome(outcome),
        () => {
          if (!this.observation?.connecting) {
            void this.observeLostHost()
          }
        }
      )
      this.removeDisconnect = this.client.onDisconnected(() => void this.observeLostHost())
      this.dispatched = true
      const { pid } = await this.client.request<{ pid: number }>(
        'spawnProvider',
        payload,
        START_TIMEOUT_MS
      )
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error('Provider host returned no process')
      }
      this.pid = pid
      this.listener.bindPid(pid)
      const channels = await withProviderStartDeadline(this.listener.ready, START_TIMEOUT_MS)
      if (this.canceled || this.settled) {
        await this.listener.close()
        await this.signalHeldRoot('SIGTERM')
        return
      }
      this.stdin.pipe(channels.duplex)
      channels.duplex.pipe(this.stdout)
      channels.stderr.pipe(this.stderr)
      watchProviderControl(channels.control, {
        onEnd: () => this.endReport(),
        onGroup: (pgid) => this.emit('message', { pgid }),
        onClose: () => {
          this.endReport()
          if (!this.settled) {
            void this.observeLostHost()
          }
        }
      })
      this.connected = true
      // The group guard's synchronous spawn listener is armed before GO can launch the CLI.
      this.emit('spawn')
      this.resolveReady()
      channels.control.write('{"go":true}\n')
      channels.control.resume()
    } catch (error) {
      if (this.settled) {
        return
      }
      const failure = error instanceof Error ? error : new Error('Provider could not start')
      if (!this.dispatched) {
        this.failBeforeDispatch(failure)
      } else {
        this.rejectReady(failure)
        await this.listener.close()
        await this.signalHeldRoot('SIGTERM')
        void this.observeLostHost()
      }
    }
  }

  private launchDirect(): void {
    void this.listener.close()
    this.useDirectChild(this.fallback())
  }

  private failBeforeDispatch(error: Error): void {
    if (this.settled) {
      return
    }
    this.spawnAbsenceKnown = true
    this.rootAbsent = true
    this.settled = true
    this.rejectReady(error)
    this.observationPending = false
    void this.listener.close()
    this.notifyTerminal('error', error)
    this.finishClose(null, null)
  }

  private observeOutcome(outcome: HostedProviderOutcome): void {
    if (this.settled) {
      return
    }
    this.settled = true
    this.observationPending = false
    this.pid ??= outcome.pid ?? undefined
    this.rootAbsent = true
    this.spawnAbsenceKnown = outcome.processless
    this.exitCode = outcome.code
    this.signalCode = outcome.signal
    this.rejectReady(new Error('Provider exited before startup completed'))
    const channels = this.listener.outputChannels
    const retained = outcome.processless
      ? Promise.resolve()
      : channels
        ? Promise.all([
            retainProviderOutput(channels.duplex, this.stdout),
            retainProviderOutput(channels.stderr, this.stderr)
          ])
        : Promise.reject(new Error('Agent output connection ended before delivery'))
    const complete = (failure?: Error): void => {
      void this.listener.close().catch(() => {})
      this.finishClose(outcome.code, outcome.signal, failure)
    }
    void retained.then(
      () => complete(),
      (error: Error) => complete(error)
    )
    this.removeEvents()
    this.removeDisconnect()
    if (outcome.processless) {
      this.notifyTerminal(
        'error',
        Object.assign(new Error('Provider supervisor could not start'), {
          code: outcome.spawnErrorCode
        })
      )
    } else {
      this.notifyTerminal('exit', outcome.code, outcome.signal)
    }
    void this.client
      ?.request('queryProvider', { nonce: this.listener.nonce, acknowledge: true }, RPC_TIMEOUT_MS)
      .catch(() => {})
  }

  private async observeLostHost(): Promise<void> {
    if (this.settled || !this.client) {
      return
    }
    if (this.observation !== null) {
      this.observationPending = true
      return
    }
    this.observationPending = false
    const observation = { connecting: false }
    this.observation = observation
    try {
      const state = await observeHostedProviderExit({
        timeoutMs: EXIT_PROOF_TIMEOUT_MS,
        isSettled: () => this.settled,
        query: () =>
          queryHostedProviderState(this.client!, this.listener.nonce, RPC_TIMEOUT_MS, observation),
        probe: () => probeHostedProviderRoot(this.pid, this.listener.nonce)
      })
      if (this.settled) {
        return
      }
      if (state.state === 'exited') {
        return this.observeOutcome(state.outcome)
      }
      if (state.state === 'live') {
        return
      }
      if (state.state === 'absent') {
        this.settled = true
        this.observationPending = false
        this.rootAbsent = true
        this.rejectReady(new Error('Provider supervisor ended before startup completed'))
        this.notifyTerminal('providerAbsent')
        await this.listener.close()
        this.finishClose(null, null)
        return
      }
      if (!this.settled) {
        // No exit proof: adapters retain writer ownership through their existing unproven-close path.
        const error = new Error('Agent connection ended before its exit could be verified')
        this.rejectReady(error)
        observationNotifications.run(this, () => this.notifyTerminal('error', error))
        // Transport failure is not ChildProcess close: helpers still own any live writer.
      }
    } catch (error) {
      if (!this.settled) {
        observationNotifications.run(this, () => this.notifyTerminal('error', error))
      }
    } finally {
      this.observation = null
      if (this.closed) {
        this.removeEvents()
        this.removeDisconnect()
      }
      if (this.observationPending && !this.settled) {
        void this.observeLostHost()
      }
    }
  }
}
