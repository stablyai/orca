import {
  buildStartupCommandPayload,
  STARTUP_COMMAND_SUBMIT_DELAY_MS
} from '../../shared/startup-command-submission'

type PendingWrite =
  | { kind: 'data'; data: string }
  | { kind: 'startup-command'; command: string; bracketedPasteSafe: boolean }

export class DelayedStartupCommandWriter {
  private submitTimer: ReturnType<typeof setTimeout> | null = null
  private pendingWrites: PendingWrite[] = []
  private startupReserved = false

  constructor(private readonly writeData: (data: string) => void) {}

  reserveStartupCommand(): void {
    this.startupReserved = true
  }

  writeStartupCommand(command: string, bracketedPasteSafe: boolean): void {
    this.startupReserved = false
    if (this.submitTimer) {
      this.pendingWrites.push({ kind: 'startup-command', command, bracketedPasteSafe })
      return
    }
    this.startSubmission(command, bracketedPasteSafe)
  }

  tryEnqueueInput(data: string): boolean {
    if (!this.startupReserved && !this.submitTimer) {
      return false
    }
    this.pendingWrites.push({ kind: 'data', data })
    return true
  }

  clear(): void {
    if (this.submitTimer) {
      clearTimeout(this.submitTimer)
      this.submitTimer = null
    }
    this.startupReserved = false
    this.pendingWrites = []
  }

  private startSubmission(command: string, bracketedPasteSafe: boolean): void {
    this.writeData(buildStartupCommandPayload(command, bracketedPasteSafe))
    this.submitTimer = setTimeout(() => {
      this.submitTimer = null
      this.writeData('\r')
      this.flushPendingWrites()
    }, STARTUP_COMMAND_SUBMIT_DELAY_MS)
  }

  private flushPendingWrites(): void {
    while (this.pendingWrites.length > 0) {
      const pending = this.pendingWrites.shift()
      if (!pending) {
        return
      }
      if (pending.kind === 'startup-command') {
        this.startSubmission(pending.command, pending.bracketedPasteSafe)
        return
      }
      this.writeData(pending.data)
    }
  }
}
