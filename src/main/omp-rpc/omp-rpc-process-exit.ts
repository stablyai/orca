import type { OmpRpcClientEvent, OmpRpcExit } from '../../shared/omp-rpc-protocol'

type OmpRpcProcessExitDependencies = {
  getStderrTail: () => string
  isProtocolV2: () => boolean
  rejectReady: (error: Error) => void
  rejectPendingResponses: (error: Error) => void
  emit: (event: Extract<OmpRpcClientEvent, { kind: 'exit' }>) => void
  clearListeners: () => void
}

export class OmpRpcProcessExit {
  private hasExitedValue = false
  private readonly exitedPromise: Promise<OmpRpcExit>
  private resolveExited!: (exit: OmpRpcExit) => void

  constructor(private readonly dependencies: OmpRpcProcessExitDependencies) {
    this.exitedPromise = new Promise<OmpRpcExit>((resolve) => {
      this.resolveExited = resolve
    })
  }

  get hasExited(): boolean {
    return this.hasExitedValue
  }

  readonly whenExited = (): Promise<OmpRpcExit> => this.exitedPromise

  readonly handle = (code: number | null, signal: NodeJS.Signals | null, cause?: Error): void => {
    if (this.hasExitedValue) {
      return
    }
    this.hasExitedValue = true
    const status = code !== null ? `code ${code}` : signal ? `signal ${signal}` : 'unknown status'
    const diagnostics = this.dependencies.getStderrTail().trim()
    const error = new Error(
      cause?.message ??
        `OMP RPC child exited with ${status}${diagnostics ? `: ${diagnostics}` : ''}`
    )
    this.dependencies.rejectPendingResponses(error)
    if (!this.dependencies.isProtocolV2()) {
      this.dependencies.rejectReady(error)
    }
    const exit = { code, signal }
    this.resolveExited(exit)
    this.dependencies.emit({ kind: 'exit', ...exit })
    this.dependencies.clearListeners()
  }
}
