import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  PassThrough,
  Transform,
  type Readable,
  type TransformCallback,
  type Writable
} from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { notifyProviderChild, type ProviderChild } from './provider-child'
import {
  PROVIDER_GROUP_REAP_TIMEOUT_MS,
  PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS,
  type ProviderSpawnSpec
} from './provider-process-supervisor'
import {
  PROVIDER_SPAWN_FAILURE_MARKER,
  supervisedProviderSpawnFailure,
  providerStderrForDisplay
} from './provider-spawn-failure-report'
import { drainDirectProviderOutput } from './direct-provider-output-drain'
import { reportProviderLaunchFailure } from './provider-launch-failure'
import {
  proveProviderProcessIdentity,
  sweepOrphanedProviderGroup
} from './provider-group-orphan-guard'
import { readPosixProcessRow, type ProviderProcessRow } from './provider-process-row-read'
import { waitForProviderGroupReap } from './provider-ownership-journal'

const REPORT_LINE_MAX_CHARS = 16_384

/** Wraps the legacy `-e` supervisor: its pid and signals are the wrapper's, never the CLI's. */
export class LegacyProviderChild extends EventEmitter implements ProviderChild {
  readonly stdin: Writable
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  groupVerdict: 'exited' | 'unverifiable' = 'unverifiable'
  private readonly stderrFilter = new LegacyStderrFilter()
  private readonly reportEnded: Promise<unknown>
  private reportedPgid?: number
  private identity: Promise<ProviderProcessRow | null> = Promise.resolve(null)
  private rawExited = false
  private failure?: Promise<Error>
  private settled = false
  // A wrapped launch whose exec fails has a pid but never spawns.
  private spawned = false

  constructor(
    private readonly raw: ChildProcess,
    private readonly spec: ProviderSpawnSpec
  ) {
    super()
    this.stdin = raw.stdin ?? new PassThrough()
    this.stdin.on('error', () => {})
    raw.stdout?.on('error', (error) => this.stdout.destroy(error))
    raw.stderr?.on('error', (error) => this.stderr.destroy(error))
    this.stdout.on('error', () => {})
    this.stderr.on('error', () => {})
    raw.stdout?.pipe(this.stdout, { end: false })
    if (raw.stderr) {
      raw.stderr.pipe(this.stderrFilter)
    } else {
      this.stderrFilter.end()
    }
    this.stderrFilter.pipe(this.stderr, { end: false })
    this.reportEnded = raw.connected
      ? new Promise((resolve) => raw.once('disconnect', resolve))
      : Promise.resolve()
    raw.once('message', (message: unknown) => this.observeReport(message))
    raw.once('spawn', () => {
      this.spawned = true
      notifyProviderChild(this, 'spawn')
    })
    raw.on('error', (error) => {
      if (this.spawned) {
        notifyProviderChild(this, 'error', error)
        return
      }
      // No path equals '', so the helper's own launch error never blames the CLI executable.
      this.failure ??= reportProviderLaunchFailure(
        error,
        { cwd: spec.cwd, command: '' },
        (failure) => notifyProviderChild(this, 'error', failure)
      )
    })
    raw.once('exit', (code, signal) => {
      this.rawExited = true
      void this.settle(code, signal)
    })
    raw.once('close', (code, signal) => {
      if (!this.spawned) {
        void this.settleProcessless(code, signal)
      }
    })
  }

  get pid(): number | undefined {
    return this.raw.pid
  }
  get writerPid(): number | undefined {
    return this.reportedPgid
  }
  get leaderExited(): boolean {
    return this.rawExited
  }
  get connected(): boolean {
    return this.raw.connected
  }
  get killed(): boolean {
    return this.raw.killed
  }

  /** SIGKILL kills only the wrapper; the exit guard then sweeps the group it proved. */
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    return this.raw.kill(signal)
  }

  private observeReport(message: unknown): void {
    const pgid =
      typeof message === 'object' && message !== null && 'pgid' in message ? message.pgid : null
    if (typeof pgid !== 'number' || !Number.isSafeInteger(pgid) || pgid < 2) {
      return
    }
    this.reportedPgid = pgid
    const supervisorPid = this.raw.pid
    // A row read after the supervisor is reaped could match a reused parent PID.
    const readRow = async (
      ...args: Parameters<typeof readPosixProcessRow>
    ): ReturnType<typeof readPosixProcessRow> => {
      const row = await readPosixProcessRow(...args)
      return this.rawExited ? 'unverifiable' : row
    }
    this.identity = proveProviderProcessIdentity(pgid, readRow)
      .then((row) => (row && row.ppid === supervisorPid && row.pgid === pgid ? row : null))
      .catch(() => null)
  }

  private async settle(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (code === 127) {
      // The report is the supervisor's last stderr line, which can trail its exit.
      await withTimeout(streamEnded(this.stderrFilter), PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS, undefined)
    }
    const spawnFailure = supervisedProviderSpawnFailure(code, this.stderrFilter.finalReport ?? '')
    if (spawnFailure) {
      this.failure ??= reportProviderLaunchFailure(
        Object.assign(spawnFailure.error, { path: this.spec.command }),
        this.spec,
        (failure) => notifyProviderChild(this, 'error', failure)
      )
    }
    await this.failure
    await this.guardGroup(spawnFailure !== null)
    await this.finish(code, signal, true)
  }

  private async settleProcessless(
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    await this.failure
    // The supervisor never started, so it cannot have started a provider group.
    this.groupVerdict = 'exited'
    await this.finish(code, signal, false)
  }

  /** Raw SIGKILL or a crash leaves the detached group behind; only its proven leader authorizes a kill. */
  private async guardGroup(providerNeverSpawned: boolean): Promise<void> {
    const proof = new AbortController()
    const timer = setTimeout(() => proof.abort(), PROVIDER_GROUP_REAP_TIMEOUT_MS)
    const deadline = performance.now() + PROVIDER_GROUP_REAP_TIMEOUT_MS
    try {
      await Promise.race([this.reportEnded, aborted(proof.signal)])
      const pgid = this.reportedPgid
      if (pgid === undefined) {
        if (providerNeverSpawned) {
          this.groupVerdict = 'exited'
        }
        return
      }
      const identity = await Promise.race([this.identity, aborted(proof.signal)])
      if (identity) {
        await Promise.race([
          sweepOrphanedProviderGroup(
            { pgid, leader: identity, watcher: identity },
            { signal: proof.signal }
          ),
          aborted(proof.signal)
        ])
      }
      const absent = await waitForProviderGroupReap(
        pgid,
        Math.max(0, deadline - performance.now()),
        proof.signal
      )
      if (absent) {
        this.groupVerdict = 'exited'
      }
    } catch {
      // A failed proof leaves the group unverifiable.
    } finally {
      clearTimeout(timer)
    }
  }

  private async finish(
    code: number | null,
    signal: NodeJS.Signals | null,
    exited: boolean
  ): Promise<void> {
    if (this.settled) {
      return
    }
    this.settled = true
    await drainDirectProviderOutput(this.raw.stdout, this.stderrFilter, this.stdout, this.stderr)
    this.raw.stderr?.destroy()
    this.stdin.destroy()
    this.exitCode = code
    this.signalCode = signal
    if (exited) {
      notifyProviderChild(this, 'exit', code, signal)
    }
    notifyProviderChild(this, 'close', code, signal)
  }
}

/** Renders supervisor spawn reports as their message, holding at most one bounded candidate line. */
class LegacyStderrFilter extends Transform {
  /** The last non-blank line, kept only while it is a supervisor report. */
  finalReport: string | null = null
  private readonly decoder = new StringDecoder('utf8')
  private held = ''
  private atLineStart = true

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.forward(this.decoder.write(chunk), false)
    done()
  }

  override _flush(done: TransformCallback): void {
    this.forward(this.decoder.end(), true)
    done()
  }

  private forward(text: string, ended: boolean): void {
    let rest = this.held + text
    this.held = ''
    let output = ''
    while (rest) {
      const newline = rest.indexOf('\n')
      const line = newline === -1 ? rest : rest.slice(0, newline)
      const end = newline === -1 ? '' : '\n'
      rest = rest.slice(line.length + end.length)
      if (!this.atLineStart) {
        if (line.trim()) {
          this.finalReport = null
        }
        output += line + end
      } else if (
        !end &&
        !ended &&
        line.length <= REPORT_LINE_MAX_CHARS &&
        (line.startsWith(PROVIDER_SPAWN_FAILURE_MARKER) ||
          PROVIDER_SPAWN_FAILURE_MARKER.startsWith(line))
      ) {
        this.held = line
        break
      } else {
        if (line.trim()) {
          this.finalReport = line.startsWith(PROVIDER_SPAWN_FAILURE_MARKER) ? line : null
        }
        output += providerStderrForDisplay(line) + end
      }
      this.atLineStart = end !== ''
    }
    if (output) {
      this.push(output)
    }
  }
}

function streamEnded(stream: Readable): Promise<void> {
  return stream.readableEnded || stream.destroyed
    ? Promise.resolve()
    : new Promise((resolve) => {
        stream.once('end', resolve)
        stream.once('close', resolve)
      })
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
    } else {
      signal.addEventListener('abort', () => resolve(), { once: true })
    }
  })
}
