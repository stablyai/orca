import { spawnProcess } from '../../shared/child-process/run-process'
import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess,
  type ProviderProcessExit
} from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { ProviderProcessCloseResult } from '../provider-process/provider-process-close'
import {
  JsonlRpcPeer,
  JsonlRpcStreamClosedError,
  type JsonlRpcPeerHandlers,
  type JsonlRpcRecord
} from './peer'
import { resolveJsonlRpcPeerOptions, type JsonlRpcPeerOptions } from './peer-limits'

export type JsonlRpcAgentConnectionOptions = JsonlRpcPeerHandlers & {
  peer?: JsonlRpcPeerOptions
  onExit?: (error: Error, context: { expected: boolean; exit: ProviderProcessExit }) => void
  /** Any stdout or stderr chunk from the child. */
  onOutput?: () => void
}

/** The owning runtime keeps process exit evidence separate from transport closure. */
export class JsonlRpcAgentConnection {
  private readonly managed: ManagedProviderProcess
  private readonly peer: JsonlRpcPeer
  private closing = false
  private finishObservedExit?: () => void
  private streamExitTimer?: ReturnType<typeof setTimeout>

  constructor(
    launch: ProviderProcessLaunch,
    private readonly options: JsonlRpcAgentConnectionOptions = {},
    spawnImpl: typeof spawnProcess = spawnProcess
  ) {
    const peerOptions = resolveJsonlRpcPeerOptions(options.peer)
    this.managed = spawnManagedProviderProcess(launch, {
      spawnImpl,
      site: 'jsonl-rpc-agent-teardown',
      ...(options.onOutput ? { onOutput: options.onOutput } : {})
    })
    const managed = this.managed
    this.peer = new JsonlRpcPeer(
      managed.child.stdout,
      managed.child.stdin,
      {
        ...options,
        onClose: (error) => {
          const fail = (): void => {
            if (this.closing || managed.rootVerdict === 'exited') {
              return
            }
            void managed.close().then(
              (result) => {
                if (result.root !== 'exited') {
                  this.diagnose('Agent exit was not proven after RPC failure')
                }
              },
              () => this.diagnose('Agent cleanup failed after RPC failure')
            )
            options.onClose?.(error)
          }
          if (
            error instanceof JsonlRpcStreamClosedError &&
            !this.closing &&
            managed.rootVerdict !== 'exited'
          ) {
            // EOF often precedes the exit carrying an import/startup failure's code.
            this.streamExitTimer = setTimeout(fail, 250)
            this.streamExitTimer.unref()
          } else {
            fail()
          }
        }
      },
      peerOptions
    )
    managed.child.on('error', this.onError)
    managed.child.stderr.on('error', this.onError)
    managed.onExit((exit) => {
      clearTimeout(this.streamExitTimer)
      // The agent's last stderr lines are what a person can act on when it dies.
      const error = withProviderDiagnostic(
        new Error(
          exit.processless
            ? 'Agent process could not start'
            : `Agent process exited (code ${exit.code ?? 'none'}, signal ${exit.signal ?? 'none'})`
        ),
        providerDiagnostic(managed.stderrTail(), 'person')
      )
      this.peer.finishOnInputEnd(error)
      const stdout = managed.child.stdout
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => {
        if (finished) {
          return
        }
        finished = true
        clearTimeout(timer)
        stdout.removeListener('end', finish)
        stdout.removeListener('close', finish)
        this.finishObservedExit = undefined
        this.peer.close(error)
        managed.child.removeListener('error', this.onError)
        try {
          options.onExit?.(error, { expected: this.closing, exit })
        } catch {
          this.diagnose('Agent exit observer failed')
        }
      }
      this.finishObservedExit = finish
      if (
        this.closing ||
        exit.processless ||
        this.peer.closed ||
        stdout.destroyed ||
        stdout.readableEnded
      ) {
        finish()
      } else {
        stdout.once('end', finish)
        stdout.once('close', finish)
        // A descendant can inherit stdout after the provider root exits.
        timer = setTimeout(finish, 1_000)
        timer.unref()
      }
    })
  }

  get pid(): number | undefined {
    return this.managed.child.pid
  }
  get closed(): boolean {
    return this.peer.closed
  }
  get rootVerdict(): ManagedProviderProcess['rootVerdict'] {
    return this.managed.rootVerdict
  }
  get processless(): boolean {
    return this.managed.processless
  }
  get lastCloseResult(): ManagedProviderProcess['lastCloseResult'] {
    return this.managed.lastCloseResult
  }

  onExit(listener: () => void): void {
    this.managed.onExit(listener)
  }

  request(
    command: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number | null } = {}
  ): Promise<unknown> {
    return this.peer.request(command, params, options)
  }

  send(record: JsonlRpcRecord): Promise<void> {
    return this.peer.send(record)
  }

  pauseReading(): void {
    this.peer.pauseReading()
  }

  resumeReading(): void {
    this.peer.resumeReading()
  }

  /** Stop sends the dialect's abort first, then closes this connection through the supervisor. */
  close(error?: Error): Promise<ProviderProcessCloseResult> {
    this.closing = true
    clearTimeout(this.streamExitTimer)
    this.finishObservedExit?.()
    this.peer.close(error)
    return this.managed.close()
  }

  private readonly onError = (error: Error): void => this.peer.close(error)
  private diagnose(message: string): void {
    try {
      this.options.onDiagnostic?.(message)
    } catch {
      /* Diagnostics cannot break cleanup. */
    }
  }
}
