import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'

export class SessionInputWriter {
  constructor(
    private readonly options: {
      subprocess: SubprocessHandle
      startupIngress: PtyStartupIngress
      shellReady: SessionShellReadyBarrier
      isWritable: () => boolean
    }
  ) {}

  write(data: string): void {
    if (!this.options.isWritable()) {
      return
    }
    if (this.options.startupIngress.answerLiveQueryReply(data)) {
      return
    }
    // Why: preserve ordering through the post-ready flush window.
    if (this.options.shellReady.tryEnqueue(data)) {
      return
    }
    this.options.subprocess.write(data)
  }

  writeStartupCommand(command: string, bracketedPasteSafe: boolean): void {
    if (this.options.isWritable()) {
      this.options.shellReady.writeStartupCommand(command, bracketedPasteSafe)
    }
  }
}
