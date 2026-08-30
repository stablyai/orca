import {
  buildStartupCommandPayload,
  STARTUP_COMMAND_SUBMIT_DELAY_MS
} from '../../shared/startup-command-submission'
import type { SubprocessHandle } from './session-subprocess-handle'

export class DelayedStartupCommandWriter {
  private readonly submitTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly subprocess: SubprocessHandle) {}

  write(command: string, bracketedPasteSafe: boolean): void {
    this.subprocess.write(buildStartupCommandPayload(command, bracketedPasteSafe))
    const timer = setTimeout(() => {
      this.submitTimers.delete(timer)
      this.subprocess.write('\r')
    }, STARTUP_COMMAND_SUBMIT_DELAY_MS)
    this.submitTimers.add(timer)
  }

  clear(): void {
    for (const timer of this.submitTimers) {
      clearTimeout(timer)
    }
    this.submitTimers.clear()
  }
}
