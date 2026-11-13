import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import type { Socket } from 'node:net'
import { encodeNdjson } from '../../../shared/main-process-ndjson-framer'
import type {
  HostedProviderOutcome,
  HostedProviderSpawn,
  HostedProviderState
} from '../protocol/daemon-provider-process-protocol'

const OUTCOME_RETENTION_MS = 60_000
const STOP_TIMEOUT_MS = 7_500
const SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR2', 'SIGSTOP', 'SIGCONT', 'SIGKILL'])

type ProviderEntry = {
  child: ChildProcess
  owner: Socket
  closed: Promise<void>
}

/** Ephemeral child authority; neither a caller PID nor a disconnected socket proves an exit. */
export class DaemonProviderProcesses {
  private readonly live = new Map<string, ProviderEntry>()
  private readonly outcomes = new Map<
    string,
    { outcome: HostedProviderOutcome; expiry: NodeJS.Timeout }
  >()
  private stopping = false

  constructor(
    readonly enabled: boolean,
    private readonly onLiveChanged: () => void
  ) {}

  get hasLive(): boolean {
    return this.live.size > 0
  }

  async spawn(spec: HostedProviderSpawn, owner: Socket): Promise<{ pid: number }> {
    if (!this.enabled || this.stopping) {
      throw new Error('Provider host unavailable')
    }
    if (
      !/^[a-f0-9]{64}$/.test(spec.nonce) ||
      typeof spec.source !== 'string' ||
      !Array.isArray(spec.args) ||
      !spec.args.every((arg) => typeof arg === 'string') ||
      typeof spec.cwd !== 'string' ||
      !spec.env ||
      typeof spec.env !== 'object' ||
      !Object.values(spec.env).every((value) => typeof value === 'string')
    ) {
      throw new Error('Invalid provider launch')
    }
    if (this.live.has(spec.nonce) || this.outcomes.has(spec.nonce)) {
      throw new Error('Provider launch already dispatched')
    }
    // The current GUI supplies its matching supervisor; the host supplies only its pinned runtime.
    const child = spawnProcess({
      program: process.execPath,
      args: ['-e', spec.source, '--', ...spec.args],
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: 'ignore'
    })
    let resolveClosed = (): void => {}
    const entry: ProviderEntry = {
      child,
      owner,
      closed: new Promise<void>((resolve) => {
        resolveClosed = resolve
      })
    }
    this.live.set(spec.nonce, entry)
    this.onLiveChanged()
    const finish = (outcome: HostedProviderOutcome): void => {
      if (this.live.get(spec.nonce) !== entry) {
        return
      }
      this.live.delete(spec.nonce)
      if (!entry.owner.destroyed) {
        entry.owner.write(encodeNdjson({ type: 'providerExit', nonce: spec.nonce, outcome }))
      }
      const expiry = setTimeout(() => this.removeOutcome(spec.nonce), OUTCOME_RETENTION_MS)
      expiry.unref()
      this.outcomes.set(spec.nonce, { outcome, expiry })
      this.onLiveChanged()
    }
    child.once('exit', (code, signal) =>
      finish({
        pid: child.pid ?? null,
        code,
        signal,
        processless: false
      })
    )
    child.once('close', () => resolveClosed())
    return new Promise((resolve, reject) => {
      child.once('spawn', () => resolve({ pid: child.pid! }))
      child.once('error', (error: NodeJS.ErrnoException) => {
        // Do not relay errors containing launch payloads, environment or private source.
        if (child.pid === undefined) {
          finish({
            pid: null,
            code: null,
            signal: null,
            processless: true,
            ...(typeof error.code === 'string' ? { spawnErrorCode: error.code } : {})
          })
        }
        reject(new Error('Provider supervisor could not start'))
      })
    })
  }

  query(nonce: string, owner: Socket, acknowledge = false): HostedProviderState {
    const retained = this.outcomes.get(nonce)
    if (retained) {
      if (acknowledge) {
        this.removeOutcome(nonce)
      }
      return { state: 'exited', outcome: retained.outcome }
    }
    const entry = this.live.get(nonce)
    if (!entry) {
      return { state: 'unknown' }
    }
    entry.owner = owner
    return entry.child.pid ? { state: 'live', pid: entry.child.pid } : { state: 'unknown' }
  }

  signal(nonce: string, owner: Socket, signal: NodeJS.Signals): { delivered: boolean } {
    const entry = this.live.get(nonce)
    if (!entry || !SIGNALS.has(signal)) {
      return { delivered: false }
    }
    entry.owner = owner
    try {
      return { delivered: entry.child.kill(signal) }
    } catch {
      return { delivered: false }
    }
  }

  async dispose(): Promise<void> {
    this.stopping = true
    const entries = [...this.live.values()]
    for (const entry of entries) {
      try {
        entry.child.kill('SIGCONT')
        entry.child.kill('SIGTERM')
      } catch {}
    }
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all(entries.map((entry) => entry.closed)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_TIMEOUT_MS)
      })
    ])
    clearTimeout(timer)
    for (const entry of this.live.values()) {
      try {
        entry.child.kill('SIGKILL')
      } catch {}
    }
    this.live.clear()
    for (const nonce of this.outcomes.keys()) {
      this.removeOutcome(nonce)
    }
  }

  private removeOutcome(nonce: string): void {
    clearTimeout(this.outcomes.get(nonce)?.expiry)
    this.outcomes.delete(nonce)
  }
}
