/** One ZCode prompt is one foreground `zcode -p ... --output-format stream-json` process. The
 *  contract (docs/HEADLESS.md) requires consuming stdout and stderr, and treating completion as
 *  exit 0 **and** a terminal `result` record: a missing result is incomplete even at status 0. */

import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import {
  isZcodeResultRecord,
  parseZcodeStreamRecord,
  zcodeRecordSessionId,
  type ZcodeResultRecord,
  type ZcodeStreamRecord
} from './zcode-stream-records'

export type ZcodeTurnCompletion = {
  sessionId: string | null
  response: string | null
  result: ZcodeResultRecord
}

/** Exit 0 without a terminal `result`, a signal, or a non-zero status all leave the turn unanswered. */
export class ZcodeIncompleteTurnError extends Error {
  constructor(
    message: string,
    readonly detail: { code: number | null; signal: string | null; stderrTail: string }
  ) {
    super(message)
    this.name = 'ZcodeIncompleteTurnError'
  }
}

export class ZcodeTurnProcess {
  private readonly managed: ManagedProviderProcess
  private readonly completion = Promise.withResolvers<ZcodeTurnCompletion>()
  private result: ZcodeResultRecord | null = null
  private sessionId: string | null = null
  private buffer = ''
  private ended = false

  constructor(
    launch: ProviderProcessLaunch,
    private readonly onRecord: (record: ZcodeStreamRecord) => void
  ) {
    this.managed = spawnManagedProviderProcess(launch, {
      site: 'zcode-turn-teardown',
      // The prompt rides argv, so stdin has no further input; its end is not a stop request.
      lifetime: 'one-shot'
    })
    this.managed.child.stdout.setEncoding('utf8')
    this.managed.child.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.managed.child.stdout.on('end', () => this.flush())
    this.managed.child.stdin.end()
    this.managed.onExit((exit) => this.settleExit(exit.code, exit.signal))
  }

  get done(): Promise<ZcodeTurnCompletion> {
    return this.completion.promise
  }

  get pid(): number | undefined {
    return this.managed.child.pid
  }

  abort(): void {
    this.managed.child.kill('SIGTERM')
    void this.managed.close().catch(() => false)
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.record(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private flush(): void {
    if (this.buffer.length > 0) {
      const line = this.buffer
      this.buffer = ''
      this.record(line)
    }
  }

  private record(line: string): void {
    const record = parseZcodeStreamRecord(line)
    if (!record) {
      return
    }
    this.sessionId ??= zcodeRecordSessionId(record)
    if (isZcodeResultRecord(record)) {
      this.result = record
    }
    this.onRecord(record)
  }

  private settleExit(code: number | null, signal: string | null): void {
    if (this.ended) {
      return
    }
    this.ended = true
    this.flush()
    const stderrTail = this.managed.stderrTail()
    if (this.result && code === 0) {
      this.completion.resolve({
        sessionId: this.sessionId,
        response: this.result.response ?? null,
        result: this.result
      })
      return
    }
    if (this.result) {
      this.completion.reject(
        new ZcodeIncompleteTurnError(`ZCode exited ${code ?? `on ${signal}`} after its result`, {
          code,
          signal,
          stderrTail
        })
      )
      return
    }
    this.completion.reject(
      new ZcodeIncompleteTurnError(
        code === null
          ? `ZCode was interrupted before it produced a result${signal ? ` (${signal})` : ''}`
          : `ZCode exited ${code} without a terminal result record`,
        { code, signal, stderrTail }
      )
    )
  }
}
