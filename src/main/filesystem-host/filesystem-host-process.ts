import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  filesystemHostChildMessageSchema,
  type FilesystemHostOperation,
  type FilesystemHostParentMessage,
  type FilesystemHostResult
} from '../../shared/filesystem-host-protocol'
import { buildFilesystemHostEnv } from './filesystem-host-env'
import { FilesystemHostProcessError } from './filesystem-host-process-error'
import { FilesystemHostReadRequests } from './filesystem-host-read-requests'

export { FilesystemHostProcessError } from './filesystem-host-process-error'
export type { FilesystemHostProcessFailureCode } from './filesystem-host-process-error'

export type FilesystemHostProcessOptions = {
  entryPath: string
  readyTimeoutMs?: number
  exitDeadlineMs?: number
  hardKillDelayMs?: number
  spawn?: (entryPath: string, args: string[], options: ForkOptions) => ChildProcess
  onPhysicalExit?: () => void
}

export class FilesystemHostProcess {
  private readonly reads = new FilesystemHostReadRequests((message, onError) =>
    this.send(message, onError)
  )
  private physicalExited = false
  private retired = false
  private workerId: string | null = null
  private readonly exitWaiters = new Set<(didExit: boolean) => void>()

  private constructor(
    private readonly child: ChildProcess,
    private readonly options: Required<
      Pick<FilesystemHostProcessOptions, 'exitDeadlineMs' | 'hardKillDelayMs'>
    >
  ) {}

  static start(options: FilesystemHostProcessOptions): Promise<FilesystemHostProcess> {
    const spawn = options.spawn ?? fork
    let child: ChildProcess
    try {
      child = spawn(options.entryPath, [], {
        env: buildFilesystemHostEnv(),
        execArgv: [],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        ...(process.platform === 'win32' ? { windowsHide: true } : {})
      })
    } catch (error) {
      options.onPhysicalExit?.()
      return Promise.reject(error)
    }
    const host = new FilesystemHostProcess(child, {
      exitDeadlineMs: options.exitDeadlineMs ?? 5_000,
      hardKillDelayMs: options.hardKillDelayMs ?? 1_000
    })
    host.bindLifecycle(options.onPhysicalExit)
    return host.awaitReady(options.readyTimeoutMs ?? 5_000)
  }

  invoke(
    operation: FilesystemHostOperation,
    deadlineMs: number,
    requestId: string = randomUUID()
  ): Promise<FilesystemHostResult> {
    if (this.retired || !this.child.connected) {
      return Promise.reject(
        new FilesystemHostProcessError('process-unavailable', 'Filesystem host is unavailable')
      )
    }
    if (!this.workerId) {
      return Promise.reject(
        new FilesystemHostProcessError(
          'process-unavailable',
          'Filesystem host identity is unavailable'
        )
      )
    }
    return this.reads.invoke(operation, deadlineMs, requestId)
  }

  retire(): Promise<boolean> {
    if (this.physicalExited) {
      return Promise.resolve(true)
    }
    if (!this.retired) {
      this.retired = true
      this.reads.rejectAll('Filesystem host was retired')
      try {
        this.child.kill()
      } catch {
        return Promise.resolve(false)
      }
    }
    return new Promise((resolve) => {
      const hardKill = setTimeout(() => {
        try {
          this.child.kill('SIGKILL')
        } catch {
          // The exit deadline owns the observable outcome.
        }
      }, this.options.hardKillDelayMs)
      hardKill.unref?.()
      const deadline = setTimeout(() => {
        clearTimeout(hardKill)
        if (this.exitWaiters.delete(finish)) {
          resolve(false)
        }
      }, this.options.exitDeadlineMs)
      deadline.unref?.()
      const finish = (didExit: boolean): void => {
        clearTimeout(hardKill)
        clearTimeout(deadline)
        resolve(didExit)
      }
      this.exitWaiters.add(finish)
    })
  }

  private awaitReady(timeoutMs: number): Promise<FilesystemHostProcess> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finishFailure = (error: FilesystemHostProcessError): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        this.child.removeListener('error', onError)
        this.child.removeListener('exit', onExit)
        this.child.removeListener('message', onMessage)
        void this.retire().finally(() => reject(error))
      }
      const timer = setTimeout(
        () =>
          finishFailure(
            new FilesystemHostProcessError('deadline', 'Filesystem host startup timed out')
          ),
        timeoutMs
      )
      timer.unref?.()
      const onMessage = (raw: unknown): void => {
        const parsed = filesystemHostChildMessageSchema.safeParse(raw)
        if (!parsed.success || parsed.data.type !== 'ready') {
          return
        }
        if (!settled) {
          settled = true
          this.workerId = parsed.data.workerId
          clearTimeout(timer)
          this.child.removeListener('error', onError)
          this.child.removeListener('exit', onExit)
          this.child.removeListener('message', onMessage)
          resolve(this)
        }
      }
      const onError = (): void =>
        finishFailure(
          new FilesystemHostProcessError('process-unavailable', 'Filesystem host failed to start')
        )
      const onExit = (): void =>
        finishFailure(
          new FilesystemHostProcessError(
            'process-unavailable',
            'Filesystem host exited before ready'
          )
        )
      this.child.on('message', onMessage)
      this.child.once('error', onError)
      this.child.once('exit', onExit)
    })
  }

  private bindLifecycle(onPhysicalExit?: () => void): void {
    this.child.on('message', (raw) => this.handleMessage(raw))
    this.child.on('disconnect', () => {
      this.reads.rejectAll('Filesystem host disconnected')
      if (!this.physicalExited) {
        void this.retire()
      }
    })
    this.child.on('error', () => {
      this.reads.rejectAll('Filesystem host process error')
    })
    const finish = (): void => {
      if (this.physicalExited) {
        return
      }
      this.physicalExited = true
      this.reads.rejectAll('Filesystem host exited')
      onPhysicalExit?.()
      for (const resolve of this.exitWaiters) {
        resolve(true)
      }
      this.exitWaiters.clear()
    }
    this.child.once('exit', finish)
    this.child.once('close', finish)
  }

  private handleMessage(raw: unknown): void {
    const parsed = filesystemHostChildMessageSchema.safeParse(raw)
    if (!parsed.success || parsed.data.type !== 'result') {
      return
    }
    const message = parsed.data
    this.reads.handle(message)
  }

  private send(message: FilesystemHostParentMessage, onError?: () => void): void {
    try {
      this.child.send(message, (error) => {
        if (error) {
          onError?.()
        }
      })
    } catch {
      onError?.()
    }
  }
}
