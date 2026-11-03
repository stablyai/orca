import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess,
  type ProviderProcessExit
} from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import {
  afterProviderOutputDrains,
  PROVIDER_EXIT_OUTPUT_DRAIN_MS
} from '../provider-process/provider-exit-output-drain'
import type { ProviderProcessCloseResult } from '../provider-process/provider-process-close'
import {
  withProviderSpawnAbsence,
  type ProviderSpawnAbsence
} from '../provider-process/provider-executable-missing'
import {
  JsonlRpcPeer,
  JsonlRpcStreamClosedError,
  type JsonlRpcPeerHandlers,
  type JsonlRpcRecord
} from './peer'
import type { JsonlRpcRequestOptions } from './peer-oversized-record'
import { resolveJsonlRpcPeerOptions, type JsonlRpcPeerOptions } from './peer-limits'

export type JsonlRpcAgentConnectionOptions = JsonlRpcPeerHandlers & {
  peer?: JsonlRpcPeerOptions
  onExit?: (error: Error, context: { expected: boolean; exit: ProviderProcessExit }) => void
}

/** The agent process ended; pending calls fail with it only once its output drained. */
export class JsonlRpcAgentExitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonlRpcAgentExitError'
  }
}

/** The owning runtime keeps process exit evidence separate from transport closure. */
export class JsonlRpcAgentConnection {
  private readonly managed: ManagedProviderProcess
  private readonly peer: JsonlRpcPeer
  private closing = false
  private finishObservedExit?: () => void
  private streamExitTimer?: ReturnType<typeof setTimeout>
  private inputEndTimer?: ReturnType<typeof setTimeout>
  private inputEnded = false

  constructor(
    launch: ProviderProcessLaunch,
    private readonly options: JsonlRpcAgentConnectionOptions = {},
    spawnImpl: PipedProcessSpawner = spawnProcess
  ) {
    const peerOptions = resolveJsonlRpcPeerOptions(options.peer)
    this.managed = spawnManagedProviderProcess(launch, {
      spawnImpl,
      site: 'jsonl-rpc-agent-teardown'
    })
    const managed = this.managed
    this.peer = new JsonlRpcPeer(
      managed.child.stdout,
      managed.child.stdin,
      {
        ...options,
        // Output often ends just before the exit whose report says how the agent ended.
        onInputEnd: (finish) => {
          this.inputEnded = true
          if (this.closing || managed.rootVerdict === 'exited') {
            finish()
          } else {
            this.inputEndTimer = setTimeout(finish, PROVIDER_EXIT_OUTPUT_DRAIN_MS)
            this.inputEndTimer.unref()
          }
        },
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
      clearTimeout(this.inputEndTimer)
      const error = withProviderSpawnAbsence(
        withProviderDiagnostic(
          new JsonlRpcAgentExitError(
            exit.processless
              ? 'Agent process could not start'
              : `Agent process exited (code ${exit.code ?? 'none'}, signal ${exit.signal ?? 'none'})`
          ),
          providerDiagnostic(managed.stderrTail(), 'person')
        ),
        managed.spawnAbsence
      )
      this.peer.finishOnInputEnd(error)
      const finish = (): void => {
        this.finishObservedExit = undefined
        this.peer.close(error)
        managed.child.removeListener('error', this.onError)
        try {
          options.onExit?.(error, { expected: this.closing, exit })
        } catch {
          this.diagnose('Agent exit observer failed')
        }
      }
      if (this.closing || exit.processless || this.peer.closed || this.inputEnded) {
        finish()
      } else {
        // A descendant can inherit stdout after the provider root exits.
        this.finishObservedExit = afterProviderOutputDrains(
          managed.child.stdout,
          finish,
          managed.child
        )
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
  /** What a spawn ENOENT proved absent: the agent's CLI or its launch folder. */
  get spawnAbsence(): ProviderSpawnAbsence | null {
    return this.managed.spawnAbsence
  }
  get lastCloseResult(): ManagedProviderProcess['lastCloseResult'] {
    return this.managed.lastCloseResult
  }

  /** `requested`: Orca was closing the agent when it exited. */
  onExit(listener: (requested?: boolean) => void): void {
    this.managed.onExit(() => listener(this.closing))
  }

  request(
    command: string,
    params: Record<string, unknown> = {},
    options: JsonlRpcRequestOptions = {}
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

  /** The dialect sends abort before the supervisor closes the process connection. */
  close(error?: Error): Promise<ProviderProcessCloseResult> {
    this.closing = true
    clearTimeout(this.streamExitTimer)
    clearTimeout(this.inputEndTimer)
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
