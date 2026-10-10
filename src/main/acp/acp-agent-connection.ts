import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess,
  type ProviderProcessExit
} from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { AcpConnectionClosedError } from './acp-errors'
import { resolveAcpPeerOptions, type AcpPeerOptions } from './acp-peer-limits'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from './acp-session-runtime'

export type AcpAgentConnectionOptions = Omit<AcpSessionRuntimeOptions, 'peer'> & {
  peer?: Omit<AcpPeerOptions, 'closeOnInputEnd'>
  /** Process exit evidence, including expected closes and processless spawn failures. */
  onExit?: (error: Error, context: { expected: boolean; exit: ProviderProcessExit }) => void
  /** Any stdout or stderr chunk from the child. */
  onOutput?: () => void
}

/** The execution host owns the child and protocol lifetime; the adapter owns turns and Stop. */
export function createAcpAgentConnection(
  launch: ProviderProcessLaunch,
  options: AcpAgentConnectionOptions = {},
  spawnImpl: PipedProcessSpawner = spawnProcess
): AcpAgentConnection {
  return new AcpAgentConnection(launch, options, spawnImpl)
}

export class AcpAgentConnection extends AcpSessionRuntime {
  private readonly managed: ManagedProviderProcess
  private readonly lifecycle: { closing: boolean; error?: Error }
  private readonly diagnoseLifecycle: (message: string) => void
  readonly spawned: Promise<void>

  constructor(
    launch: ProviderProcessLaunch,
    options: AcpAgentConnectionOptions = {},
    spawnImpl: PipedProcessSpawner = spawnProcess
  ) {
    // Validate before spawning so invalid limits cannot leave an unowned child.
    const peer = resolveAcpPeerOptions({ ...options.peer, closeOnInputEnd: false })
    const managed = spawnManagedProviderProcess(launch, {
      spawnImpl,
      site: 'acp-agent-teardown',
      ...(options.onOutput ? { onOutput: options.onOutput } : {})
    })
    const lifecycle: { closing: boolean; error?: Error } = { closing: false }
    const diagnose = (message: string): void => {
      try {
        options.onDiagnostic?.(message)
      } catch {
        /* Diagnostics cannot interrupt cleanup. */
      }
    }
    super(managed.child.stdout, managed.child.stdin, {
      ...options,
      peer,
      onClose: (error) => {
        lifecycle.error ??= error
        if (lifecycle.closing || managed.rootVerdict === 'exited') {
          return
        }
        void managed.close().then(
          (result) => {
            if (result.root !== 'exited') {
              diagnose('ACP agent exit was not proven after transport failure')
            }
          },
          (failure: unknown) => diagnose(`ACP agent cleanup failed: ${String(failure)}`)
        )
        options.onClose?.(error)
      }
    })
    this.managed = managed
    this.lifecycle = lifecycle
    this.diagnoseLifecycle = diagnose
    const { child } = managed
    this.spawned = new Promise((resolve) => {
      if (child.pid !== undefined) {
        resolve()
        return
      }
      const done = (): void => {
        child.removeListener('spawn', done)
        child.removeListener('error', done)
        resolve()
      }
      child.once('spawn', done)
      child.once('error', done)
    })
    child.on('error', (error) => super.close(error))
    child.stderr.on('error', (error) => super.close(error))
    managed.onExit((exit) => {
      const error =
        lifecycle.error ??
        new AcpConnectionClosedError(managed.stderrTail().trim() || `${launch.command} exited`)
      super.close(error)
      try {
        options.onExit?.(error, { expected: lifecycle.closing, exit })
      } catch (failure) {
        diagnose(`ACP exit listener failed: ${String(failure)}`)
      }
    })
  }

  get pid(): number | undefined {
    return this.managed.child.pid
  }

  get exited(): boolean {
    return this.managed.rootVerdict === 'exited'
  }

  get rootVerdict(): ManagedProviderProcess['rootVerdict'] {
    return this.managed.rootVerdict
  }

  /** Retained evidence from the last close attempt; a null tree means no observation. */
  get lastCloseResult(): Readonly<ManagedProviderProcess['lastCloseResult']> {
    return this.managed.lastCloseResult
  }

  /** Reports retained cleanup uncertainty; false does not prove descendant exit. */
  get processTreeUnproven(): boolean {
    const result = this.lastCloseResult
    return this.exited && (result?.tree === 'unverifiable' || result?.tree === 'live')
  }

  stderrTail(): string {
    return this.managed.stderrTail().trim()
  }

  onExit(listener: (exit: ProviderProcessExit) => void): void {
    this.managed.onExit((exit) => {
      try {
        listener(exit)
      } catch (failure) {
        this.diagnoseLifecycle(`ACP exit listener failed: ${String(failure)}`)
      }
    })
  }

  pauseReading(): void {
    this.managed.child.stdout.pause()
  }

  resumeReading(): void {
    this.managed.child.stdout.resume()
  }

  override close(error?: Error): Promise<boolean> {
    this.lifecycle.closing ||= this.managed.rootVerdict !== 'exited'
    this.drainNotifications(error)
    return this.managed
      .close()
      .then((result) => result.root === 'exited')
      .finally(() => super.close(error))
  }
}
