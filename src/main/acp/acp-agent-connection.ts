import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess,
  type ProviderProcessExit
} from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { AcpConnectionClosedError, AcpSignInPromptError } from './acp-errors'
import { resolveAcpPeerOptions, type AcpPeerOptions } from './acp-peer-limits'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from './acp-session-runtime'

export type AcpSignInWatch = {
  /** Returns a valid link, null for a malformed sign-in line, or undefined for other output. */
  read(line: string, source: 'stdout' | 'stderr'): string | null | undefined
  answered?(signedIn: boolean): void
  /** Keeps the connection open for sign-in instead of closing it signed out. */
  link?(link: string): void
}

// Allow full sign-in links while keeping the diagnostic tail smaller.
const SIGN_IN_LINE_MAX_CHARS = 32_768

export type AcpAgentConnectionOptions = Omit<AcpSessionRuntimeOptions, 'peer'> & {
  peer?: Omit<AcpPeerOptions, 'closeOnInputEnd'>
  /** Process exit evidence, including expected closes and processless spawn failures. */
  onExit?: (error: Error, context: { expected: boolean; exit: ProviderProcessExit }) => void
  onOutput?: () => void
  signIn?: AcpSignInWatch
}

/** The host owns process lifetime; the adapter owns turns and Stop. */
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
    // Invalid limits must fail before spawning an unowned child.
    const peer = resolveAcpPeerOptions({ ...options.peer, closeOnInputEnd: false })
    const { signIn } = options
    let signedOut = (): void => {}
    let unreadable = (): void => {}
    // Never retain sign-in links in diagnostics.
    const signInLine = (line: string, source: 'stdout' | 'stderr', cut = false): boolean => {
      const link = signIn?.read(line, source)
      if (link === undefined) {
        return false
      }
      if (link !== null && !cut) {
        if (signIn?.link) {
          signIn.link(link)
        } else {
          signedOut()
        }
      } else if (source === 'stdout') {
        unreadable()
      }
      return true
    }
    const managed = spawnManagedProviderProcess(launch, {
      spawnImpl,
      site: 'acp-agent-teardown',
      ...(options.onOutput ? { onOutput: options.onOutput } : {}),
      ...(signIn
        ? {
            onStderrLine: (line: string, cut: boolean) => signInLine(line, 'stderr', cut),
            stderrLineMaxChars: SIGN_IN_LINE_MAX_CHARS
          }
        : {})
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
      onOtherLine: (line, cut) => signInLine(line, 'stdout', cut),
      onAuthAnswered: (signedIn) => signIn?.answered?.(signedIn),
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
    signedOut = () => {
      signIn?.answered?.(false)
      super.close(new AcpSignInPromptError('The agent asked to sign in in a browser'))
    }
    // A malformed protocol-stream link closes the connection without reporting signed-out status.
    unreadable = () =>
      super.close(new AcpConnectionClosedError('The agent printed a sign-in link Orca cannot read'))
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

  /** Null tree means no observation. */
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
