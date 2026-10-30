import type { ProviderReceiveDisposition } from '../provider-process/provider-source-completion'
import type { ProviderProcessCloseResult } from '../provider-process/provider-process-close'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess,
  type ProviderProcessExit
} from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import {
  withProviderSpawnAbsence,
  type ProviderSpawnAbsence
} from '../provider-process/provider-executable-missing'
import { AcpConnectionClosedError, AcpSignInPromptError } from './acp-errors'
import { resolveAcpPeerOptions, type AcpPeerOptions } from './acp-peer-limits'
import { AcpSessionRuntime, type AcpSessionRuntimeOptions } from './acp-session-runtime'

export type AcpCloseOutcome = {
  accepted: boolean
  physical: ProviderProcessCloseResult
  receive: ProviderReceiveDisposition
  cleanupError?: unknown
}

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
  onExit?: (
    error: Error,
    context: { expected: boolean; exit: ProviderProcessExit; inputDone?: Promise<void> }
  ) => void | Promise<void>
  /** Finite input and response normalization have finished; never join process cleanup here. */
  onInputComplete?: (error?: Error) => void
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
  private inputDone?: Promise<void>
  private receiveResult?: Promise<ProviderReceiveDisposition>
  private closeAttempt?: Promise<AcpCloseOutcome>
  private exitPublication?: Promise<void>
  private readonly onInputComplete: AcpAgentConnectionOptions['onInputComplete']
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
        // A preclosed pipe can report loss while the base constructor is still running.
        void Promise.resolve()
          .then(() => this.completeInput(error))
          .catch((failure: unknown) => diagnose(`ACP input completion failed: ${String(failure)}`))
        if (lifecycle.closing || managed.rootVerdict === 'exited') {
          return
        }
        void managed
          .close()
          .then((result) => {
            if (result.root !== 'exited') {
              diagnose('ACP agent exit was not proven after transport failure')
            }
          })
          .catch((failure: unknown) => diagnose(`ACP agent cleanup failed: ${String(failure)}`))
        options.onClose?.(error)
      }
    })
    this.onInputComplete = options.onInputComplete
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
      const error = withProviderSpawnAbsence(
        lifecycle.error ??
          new AcpConnectionClosedError(managed.stderrTail().trim() || `${launch.command} exited`),
        managed.spawnAbsence
      )
      this.drainNotifications(error)
      const inputDone = this.completeInput(error)
      try {
        this.exitPublication = Promise.resolve(
          options.onExit?.(error, { expected: lifecycle.closing, exit, inputDone })
        )
        void this.exitPublication.catch((failure: unknown) =>
          diagnose(`ACP exit listener failed: ${String(failure)}`)
        )
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

  /** What a spawn ENOENT proved absent: the agent's CLI or its launch folder. */
  get spawnAbsence(): ProviderSpawnAbsence | null {
    return this.managed.spawnAbsence
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

  /** First managed exit observation, including processless spawn failure. */
  get exitStatus(): ProviderProcessExit | null {
    return this.managed.exitStatus
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
    if (this.lifecycle.closing || this.managed.rootVerdict === 'exited' || this.closed) {
      return
    }
    this.managed.child.stdout.pause()
  }

  resumeReading(): void {
    this.managed.child.stdout.resume()
  }

  private completeInput(error?: Error): Promise<void> {
    this.inputDone ??= Promise.resolve()
      .then(() => this.finishInput())
      .then(
        () => {
          super.close(error)
          this.onInputComplete?.(this.lifecycle.error ?? error)
        },
        (failure: unknown) => {
          const error = failure instanceof Error ? failure : new Error(String(failure))
          super.close(error)
          this.onInputComplete?.(error)
          throw error
        }
      )
    return this.inputDone
  }

  closeOutcome(error?: Error): Promise<AcpCloseOutcome> {
    if (this.closeAttempt) {
      return this.closeAttempt
    }
    this.lifecycle.closing ||= this.managed.rootVerdict !== 'exited'
    this.drainNotifications(error)
    const attempt = this.managed.close().then(async (physical): Promise<AcpCloseOutcome> => {
      const accepted = physical.root === 'exited' || physical.killDelivered === true
      let receive: ProviderReceiveDisposition = { state: 'retained' }
      if (accepted || this.inputEnding) {
        this.receiveResult ??= this.completeInput(error).then(
          () => ({ state: 'complete' as const }),
          (error: unknown) => ({ state: 'failed' as const, error })
        )
        receive = await this.receiveResult
      }
      const cleanupError =
        physical.root === 'exited'
          ? await this.exitPublication?.then(
              () => undefined,
              (error: unknown) => error
            )
          : undefined
      return {
        accepted,
        physical,
        receive,
        ...(cleanupError === undefined ? {} : { cleanupError })
      }
    })
    this.closeAttempt = attempt
    void attempt.then(
      (outcome) => {
        if (!outcome.accepted && this.closeAttempt === attempt) {
          this.closeAttempt = undefined
        }
      },
      () => {
        if (this.closeAttempt === attempt) {
          this.closeAttempt = undefined
        }
      }
    )
    return attempt
  }

  override async close(error?: Error): Promise<boolean> {
    const outcome = await this.closeOutcome(error)
    if (outcome.receive.state === 'failed') {
      throw outcome.receive.error
    }
    if (outcome.cleanupError !== undefined) {
      throw outcome.cleanupError
    }
    return outcome.accepted
  }
}
