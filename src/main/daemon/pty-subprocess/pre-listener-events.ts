import {
  resolveProcessExitCause,
  type TerminalExitCause
} from '../../../shared/terminal-exit-cause'

const PENDING_PRE_LISTENER_DATA_MAX_CHARS = 512 * 1024

type DataListener = (data: string) => void
type ExitListener = (code: number, cause?: TerminalExitCause) => void

/** Preserves spawn-time output and exit ordering until Session installs its listeners. */
export class PtyPreListenerEvents {
  private onDataCb: DataListener | null = null
  private onExitCb: ExitListener | null = null
  private pendingData: string[] = []
  private pendingDataChars = 0
  private pendingExitCode: number | null = null
  private pendingExitCause: TerminalExitCause | null = null

  acceptData(data: string): void {
    if (this.onDataCb) {
      this.onDataCb(data)
      return
    }
    this.pendingData.push(data)
    this.pendingDataChars += data.length
    while (this.pendingDataChars > PENDING_PRE_LISTENER_DATA_MAX_CHARS) {
      const removed = this.pendingData.shift()
      if (removed === undefined) {
        this.pendingDataChars = 0
        return
      }
      this.pendingDataChars -= removed.length
    }
  }

  acceptExit(args: {
    exitCode: number
    signal?: number
    hostReportsChildExitStatus: boolean
  }): void {
    const cause = resolveProcessExitCause(args)
    if (this.onExitCb) {
      this.flushData()
      this.onExitCb(args.exitCode, cause)
    } else {
      this.pendingExitCode = args.exitCode
      this.pendingExitCause = cause
    }
  }

  onData(cb: DataListener): void {
    this.onDataCb = cb
    this.flushData()
  }

  onExit(cb: ExitListener): void {
    this.onExitCb = cb
    if (this.pendingExitCode === null) {
      return
    }
    const code = this.pendingExitCode
    const cause = this.pendingExitCause ?? resolveProcessExitCause({ exitCode: code })
    this.pendingExitCode = null
    this.pendingExitCause = null
    this.flushData()
    cb(code, cause)
  }

  clear(): void {
    this.onDataCb = null
    this.onExitCb = null
    this.pendingData = []
    this.pendingDataChars = 0
    this.pendingExitCode = null
    this.pendingExitCause = null
  }

  private flushData(): void {
    if (!this.onDataCb || this.pendingData.length === 0) {
      return
    }
    const pending = this.pendingData
    this.pendingData = []
    this.pendingDataChars = 0
    for (const data of pending) {
      this.onDataCb(data)
    }
  }
}
