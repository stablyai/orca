import { readShellLifecycleStateFile } from './managed-shell-lifecycle-state-file'
import type { ShellLifecycleObservation } from '../shared/terminal-shell-lifecycle'
import type { PtyChildProcessVerdict } from '../shared/terminal-process-inspection'

export const SHELL_LIFECYCLE_BINDING_ENV = '_ORCA_SHELL_LIFECYCLE_BINDING'
const PREFIX = '\x1b]777;orca-shell-lifecycle;'
const MAX_EVENT_LENGTH = 512
const MAX_SIGNAL_AGE_MS = 30_000

/** Live process-host evidence only; never restore this state from terminal history. */
export class ManagedShellLifecycle {
  private tail = ''
  private dropping = false
  private sequence = 0
  private revision = 0
  private phase: ShellLifecycleObservation['phase'] = 'unknown'
  private reason = 'missing-integration'
  private signalAt: number | null = null

  constructor(
    private readonly binding: string | undefined,
    private readonly statePath?: string
  ) {}

  get generation(): number {
    return this.revision
  }

  accept(data: string): string {
    let input = this.tail + data
    this.tail = ''
    let output = ''
    while (input.length > 0) {
      const start = this.dropping ? 0 : input.indexOf(PREFIX)
      if (start < 0) {
        let held = Math.min(input.length, PREFIX.length - 1)
        while (held > 0 && !PREFIX.startsWith(input.slice(-held))) {
          held--
        }
        this.tail = held === 0 ? '' : input.slice(-held)
        return output + input.slice(0, input.length - held)
      }
      output += input.slice(0, start)
      input = input.slice(start)
      const bel = input.indexOf('\x07')
      const st = input.indexOf('\x1b\\')
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
      if (end < 0) {
        this.invalidate('pending-event')
        if (input.length > MAX_EVENT_LENGTH || this.dropping) {
          this.invalidate('invalid-event')
          this.dropping = true
          this.tail = input.endsWith('\x1b') ? '\x1b' : ''
        } else {
          this.tail = input
        }
        return output
      }
      if (!this.dropping && end <= MAX_EVENT_LENGTH) {
        this.record(input.slice(PREFIX.length, end))
      } else {
        this.invalidate('invalid-event')
      }
      this.dropping = false
      input = input.slice(end + (end === st ? 2 : 1))
    }
    return output
  }

  invalidateInput(): void {
    this.invalidate('input')
  }

  async observe(
    children: PtyChildProcessVerdict,
    expectedGeneration = this.revision
  ): Promise<ShellLifecycleObservation> {
    const live = this.phase === 'unknown' ? null : await readShellLifecycleStateFile(this.statePath)
    const receiptAge =
      this.signalAt === null ? null : Math.max(0, performance.now() - this.signalAt)
    const age = live === null ? receiptAge : Math.max(receiptAge ?? 0, live.ageMs)
    const reason =
      expectedGeneration !== this.revision
        ? 'generation-changed'
        : this.phase !== 'unknown' &&
            (!live || live.value !== `${this.binding};${this.sequence};${this.phase}\n`)
          ? 'live-state-unverifiable'
          : age !== null && age > MAX_SIGNAL_AGE_MS
            ? 'stale'
            : this.phase === 'prompt' && children !== 'no-children'
              ? children
              : this.reason
    return {
      confidence:
        reason === 'managed-bash-prompt' || reason === 'managed-bash-command'
          ? 'cooperative'
          : 'none',
      phase:
        reason === 'managed-bash-prompt'
          ? 'prompt'
          : reason === 'managed-bash-command'
            ? 'running'
            : 'unknown',
      source: this.signalAt === null ? 'none' : 'managed-bash',
      reason,
      generation: this.revision,
      signalAgeMs: age
    }
  }

  private record(payload: string): void {
    const [binding, rawSequence, phase, extra] = payload.split(';')
    const sequence = Number(rawSequence)
    if (!this.binding || binding !== this.binding) {
      this.invalidate('foreign-integration')
      return
    }
    if (
      extra !== undefined ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0 ||
      sequence !== this.sequence + 1 ||
      (phase !== 'prompt' && phase !== 'running' && phase !== 'unknown')
    ) {
      if (Number.isSafeInteger(sequence) && sequence > this.sequence) {
        this.sequence = sequence
      }
      this.invalidate('invalid-sequence')
      return
    }
    this.sequence = sequence
    this.revision++
    this.signalAt = performance.now()
    this.phase = phase
    this.reason =
      phase === 'prompt'
        ? 'managed-bash-prompt'
        : phase === 'running'
          ? 'managed-bash-command'
          : 'unsupported-hooks'
  }

  private invalidate(reason: string): void {
    this.revision++
    this.phase = 'unknown'
    this.reason = reason
  }
}
