import { z } from 'zod'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess,
  type ProviderProcessExit
} from '../../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import {
  afterProviderOutputDrains,
  PROVIDER_EXIT_OUTPUT_DRAIN_MS
} from '../../provider-process/provider-exit-output-drain'
import {
  withProviderSpawnAbsence,
  type ProviderSpawnAbsence
} from '../../provider-process/provider-executable-missing'
import {
  AcpAgentExitedError,
  AcpConnectionClosedError,
  AcpSignInPromptError
} from '../transport/acp-errors'
import { resolveAcpPeerOptions, type AcpPeerOptions } from '../transport/acp-peer-limits'
import { AcpSessionRuntime } from '../protocol/acp-session-runtime'
import type { AcpSessionRuntimeOptions } from '../protocol/acp-session-runtime-options'

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

type AcpConnectionLifecycle = {
  closing: boolean
  error?: Error
  /** The process's own failure, such as its spawn; it is no refusal by Orca. */
  processError?: Error
  /** Why the connection closed before the process exited, unless Orca closed it or the process
   *  itself failed. Taken when it closed. */
  lost?: Error
  finishExit?: () => void
  outputEndTimer?: ReturnType<typeof setTimeout>
}

export class AcpAgentConnection extends AcpSessionRuntime {
  private readonly managed: ManagedProviderProcess
  private readonly lifecycle: AcpConnectionLifecycle
  private readonly diagnoseLifecycle: (message: string) => void
  readonly spawned: Promise<void>

  /** Any session the agent reports on this connection, including a subagent's child session. */
  closeSession = (sessionId: string, timeoutMs = 10_000): Promise<unknown> =>
    this.peer.request('session/close', { sessionId }, { timeoutMs, onTimeout: 'cancel' })

  constructor(
    launch: ProviderProcessLaunch,
    options: AcpAgentConnectionOptions = {},
    spawnImpl: PipedProcessSpawner = spawnProcess
  ) {
    // Invalid limits must fail before spawning an unowned child.
    const peer = resolveAcpPeerOptions({ ...options.peer, closeOnInputEnd: false })
    const { signIn } = options
    const lifecycle: AcpConnectionLifecycle = { closing: false }
    let answerAuth = (_signedIn: boolean): void => {}
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
      onAuthAnswered: (signedIn) => answerAuth(signedIn),
      // A closed stdin usually means the agent is exiting; its exit settles calls once its output
      // drained, so the bound only covers an agent that stopped reading without exiting.
      onOutputEnd: (_error, finish) => {
        lifecycle.outputEndTimer = setTimeout(finish, PROVIDER_EXIT_OUTPUT_DRAIN_MS)
        lifecycle.outputEndTimer.unref()
      },
      onClose: (error) => {
        if (
          !lifecycle.error &&
          !lifecycle.closing &&
          managed.rootVerdict !== 'exited' &&
          error !== lifecycle.processError
        ) {
          lifecycle.lost = error
        }
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
    answerAuth = (signedIn) => {
      if (!lifecycle.closing && !this.closed) {
        signIn?.answered?.(signedIn)
      }
    }
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
    child.on('error', (error) => {
      lifecycle.processError ??= error
      super.close(error)
    })
    signedOut = () => {
      answerAuth(false)
      super.close(new AcpSignInPromptError('The agent asked to sign in in a browser'))
    }
    // A malformed protocol-stream link closes the connection without reporting signed-out status.
    unreadable = () =>
      super.close(new AcpConnectionClosedError('The agent printed a sign-in link Orca cannot read'))
    child.stderr.on('error', (error) => super.close(error))
    managed.onExit((exit) => {
      const expected = lifecycle.closing
      const finish = (): void => {
        clearTimeout(lifecycle.outputEndTimer)
        const detail = managed.stderrTail().trim() || `${launch.command} exited`
        // Only an exit Orca neither caused nor preceded with its own refusal leaves calls unanswered.
        const error = withProviderSpawnAbsence(
          lifecycle.error ??
            (expected
              ? new AcpConnectionClosedError(detail)
              : new AcpAgentExitedError(detail, managed.stderrTail().trim())),
          managed.spawnAbsence
        )
        super.close(error)
        try {
          options.onExit?.(error, { expected, exit })
        } catch (failure) {
          diagnose(`ACP exit listener failed: ${String(failure)}`)
        }
      }
      // A closed connection has no call left for the agent's output to answer.
      if (lifecycle.closing || exit.processless || this.closed) {
        finish()
      } else {
        // An answer written just before exit must still settle its call.
        lifecycle.finishExit = afterProviderOutputDrains(child.stdout, finish, child)
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

  /** Requires advertised session listing support. */
  listSessions(cwd: string): Promise<unknown> {
    return this.call('session/list', { cwd }, z.unknown())
  }

  /** The stderr tail once an exited process's stderr ends, bounded for a descendant holding it. */
  async stderrTailAfterExit(): Promise<string> {
    const stderr = this.managed.child.stderr
    if (this.exited && !stderr.readableEnded && !stderr.destroyed) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer)
          stderr.removeListener('end', finish)
          stderr.removeListener('close', finish)
          resolve()
        }
        const timer = setTimeout(finish, PROVIDER_EXIT_OUTPUT_DRAIN_MS)
        timer.unref?.()
        stderr.once('end', finish)
        stderr.once('close', finish)
      })
    }
    return this.stderrTail()
  }

  /** First managed exit observation, including processless spawn failure. */
  get exitStatus(): ProviderProcessExit | null {
    return this.managed.exitStatus
  }

  /** Why the connection closed before the process exited, such as Orca refusing what the agent
   *  wrote; never the process's own failure or its exit. Kept from the moment it closed. */
  get lostBeforeExit(): Error | undefined {
    return this.lifecycle.lost
  }

  /** `requested`: Orca was closing the agent when it exited. `lost`: why the connection had
   *  already closed before the exit, such as Orca refusing what the agent wrote. */
  onExit(listener: (exit: ProviderProcessExit, requested?: boolean, lost?: Error) => void): void {
    this.managed.onExit((exit) => {
      try {
        listener(exit, this.lifecycle.closing, this.lifecycle.lost)
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
    clearTimeout(this.lifecycle.outputEndTimer)
    this.lifecycle.finishExit?.()
    this.drainNotifications(error)
    return this.managed
      .close()
      .then((result) => result.root === 'exited' || result.killDelivered === true)
      .finally(() => super.close(error))
  }
}
