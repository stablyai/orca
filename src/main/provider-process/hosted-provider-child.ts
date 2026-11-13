import type { PassThrough } from 'node:stream'
import { observeHostedProviderExit } from './hosted-provider-exit-observer'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type {
  HostedProviderOutcome,
  HostedProviderState
} from '../daemon/protocol/daemon-provider-process-protocol'
import { ProviderOwnerListener, watchProviderControl } from './provider-owner-channels'
import { ProviderChildHandle } from './provider-child-handle'
import type { createProviderSpawnSpec } from './provider-process-supervisor'
import { probeAgentSessionProcessIdentity } from '../runtime/agent-session/ownership/agent-session-process-identity-probe'

type ProviderSpawnSpec = ReturnType<typeof createProviderSpawnSpec>
const START_TIMEOUT_MS = 10_000
const EXIT_PROOF_TIMEOUT_MS = 8_000
const RPC_TIMEOUT_MS = 1_000

/** Streams exist before a remote spawn; only the owning host may supply its PID and exit. */
export class HostedProviderChild extends ProviderChildHandle {
  private readonly listener = new ProviderOwnerListener()
  private client: DaemonClient | null = null
  private dispatched = false
  private canceled = false
  private observing = false
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
      void this.observeLostHost()
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
      const identity = this.client.getDaemonIdentity()
      if (!identity?.providerSpawn) {
        return this.launchDirect()
      }
      const env = Object.fromEntries(
        Object.entries(this.spec.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      )
      const supervisor = JSON.parse(
        Buffer.from(env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString('utf8')
      )
      env.ORCA_PROVIDER_SUPERVISOR_SPEC = Buffer.from(
        JSON.stringify({
          ...supervisor,
          ownerPid: identity.pid
        })
      ).toString('base64')
      env.ORCA_PROVIDER_OWNER_CHANNEL = JSON.stringify({ path, nonce: this.listener.nonce })
      this.removeEvents = this.client.onProviderExit(
        this.listener.nonce,
        (outcome) => this.observeOutcome(outcome),
        () => void this.observeLostHost()
      )
      this.removeDisconnect = this.client.onDisconnected(() => void this.observeLostHost())
      this.dispatched = true
      const { pid } = await this.client.request<{ pid: number }>(
        'spawnProvider',
        {
          nonce: this.listener.nonce,
          source: this.spec.args[1],
          args: this.spec.args.slice(3),
          cwd: this.spec.cwd,
          env
        },
        START_TIMEOUT_MS
      )
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error('Provider host returned no process')
      }
      this.pid = pid
      this.listener.bindPid(pid)
      const channels = await this.withStartDeadline(this.listener.ready)
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
    this.emit('error', error)
    void this.listener.close()
    this.finishClose(null, null)
  }

  private observeOutcome(outcome: HostedProviderOutcome): void {
    if (this.settled) {
      return
    }
    this.settled = true
    this.pid ??= outcome.pid ?? undefined
    this.rootAbsent = true
    this.spawnAbsenceKnown = outcome.processless
    this.exitCode = outcome.code
    this.signalCode = outcome.signal
    this.rejectReady(new Error('Provider exited before startup completed'))
    if (outcome.processless) {
      this.emit(
        'error',
        Object.assign(new Error('Provider supervisor could not start'), {
          code: outcome.spawnErrorCode
        })
      )
    } else {
      this.emit('exit', outcome.code, outcome.signal)
    }
    void this.client
      ?.request('queryProvider', { nonce: this.listener.nonce, acknowledge: true }, RPC_TIMEOUT_MS)
      .catch(() => {})
    this.removeEvents()
    this.removeDisconnect()
    // The real exit may arrive before the kernel delivers the final pipe bytes.
    let timer: NodeJS.Timeout | undefined
    const end = (stream: PassThrough): Promise<void> =>
      stream.writableFinished
        ? Promise.resolve()
        : new Promise((resolve) => stream.once('finish', resolve))
    void Promise.race([
      Promise.all([end(this.stdout), end(this.stderr)]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000)
      })
    ]).then(() => {
      clearTimeout(timer)
      void this.listener.close()
      this.finishClose(outcome.code, outcome.signal)
    })
  }

  private async observeLostHost(): Promise<void> {
    if (this.observing || this.settled || !this.client) {
      return
    }
    this.observing = true
    try {
      const state = await observeHostedProviderExit({
        timeoutMs: EXIT_PROOF_TIMEOUT_MS,
        isSettled: () => this.settled,
        query: async () => {
          await this.client!.ensureConnectedWithin(RPC_TIMEOUT_MS)
          return this.client!.request<HostedProviderState>(
            'queryProvider',
            { nonce: this.listener.nonce },
            RPC_TIMEOUT_MS
          )
        },
        probe: async () =>
          this.pid
            ? probeAgentSessionProcessIdentity({
                identity: {
                  hostId: 'local',
                  pid: this.pid,
                  processStartTimeMs: null,
                  spawnToken: this.listener.nonce
                }
              })
            : { outcome: 'indeterminate', reason: 'Supervisor PID not known' }
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
        this.rootAbsent = true
        this.rejectReady(new Error('Provider supervisor ended before startup completed'))
        this.emit('providerAbsent')
        await this.listener.close()
        this.finishClose(null, null)
        return
      }
      if (!this.settled) {
        // No exit proof: adapters retain writer ownership through their existing unproven-close path.
        const error = new Error('Agent connection ended before its exit could be verified')
        this.rejectReady(error)
        this.emit('error', error)
        // Transport failure is not ChildProcess close: helpers still own any live writer.
      }
    } finally {
      this.observing = false
      if (this.closed) {
        this.removeEvents()
        this.removeDisconnect()
      }
    }
  }

  private async withStartDeadline<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Provider launch timed out')), START_TIMEOUT_MS)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
