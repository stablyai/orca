import { randomUUID } from 'node:crypto'
import { spawnProcess } from '../../shared/child-process/run-process'
import { harnessProcessInvocation } from './harness-process-invocation'
import { killCodexAppServerProcessTree } from '../codex/codex-app-server-session'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'

type PendingRequest = { resolve: (value: OmpRpcFrame) => void; reject: (error: Error) => void }
export type OmpRpcFrame = Record<string, unknown> & { type?: string; id?: string }

export class OmpRpcError extends Error {}

export class OmpRpcConnection {
  private readonly child: ReturnType<typeof spawnProcess>
  private readonly pending = new Map<string, PendingRequest>()
  private buffer = ''
  private readonly readyPromise: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void

  constructor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    private readonly onFrame: (frame: OmpRpcFrame) => void,
    private readonly onClose: (error: Error) => void
  ) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    const invocation = harnessProcessInvocation(command, args, env)
    this.child = spawnProcess({
      program: invocation.command,
      args: invocation.args,
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child.stderr.on('data', () => undefined)
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => this.ingest(chunk))
    this.child.on('error', (error) => this.fail(error))
    this.child.on('close', () => this.fail(new Error('omp_rpc_closed')))
    this.child.stdin.on('error', (error) => this.fail(error))
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  get pid(): number {
    return this.child.pid ?? 0
  }

  request(
    type: string,
    params: Record<string, unknown> = {},
    id = randomUUID()
  ): Promise<OmpRpcFrame> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, type, ...params })
    })
  }

  write(frame: OmpRpcFrame): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) {
      return
    }
    this.child.stdin.end()
    const closed = new Promise<void>((resolve) => this.child.once('close', () => resolve()))
    await waitForProcessExitUntil(closed, 1_000)
    if (this.child.exitCode === null) {
      killCodexAppServerProcessTree(this.child)
    }
  }

  private ingest(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) {
        try {
          this.handle(JSON.parse(line) as OmpRpcFrame)
        } catch {}
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  private handle(frame: OmpRpcFrame): void {
    if (frame.type === 'ready') {
      this.resolveReady()
      return
    }
    if (frame.type === 'response' && frame.id) {
      const pending = this.pending.get(frame.id)
      if (pending) {
        this.pending.delete(frame.id)
        if (frame.success === false) {
          pending.reject(
            new OmpRpcError(typeof frame.error === 'string' ? frame.error : 'omp_rpc_failed')
          )
        } else {
          pending.resolve(frame)
        }
        return
      }
    }
    this.onFrame(frame)
  }

  private fail(error: Error): void {
    this.rejectReady(error)
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.onClose(error)
  }
}
