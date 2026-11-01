import type { PipedChildProcess, PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { RetryableProcessExitProof } from '@orca/process-host/retryable-process-exit-proof'
import type { ProviderProcessLaunch } from './provider-process-launch'
import {
  PROVIDER_SUPERVISOR_MAX_STOP_MS,
  createProviderSpawnSpec,
  type ProviderSupervisorLifetime
} from './provider-process-supervisor'
import {
  terminateProviderProcessTree,
  type ProviderProcessTeardownVerdict
} from './provider-process-teardown'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { providerSpawnAbsence, type ProviderSpawnAbsence } from './provider-executable-missing'
import { supervisedProviderSpawnFailure } from './provider-spawn-failure-report'
import { guardSupervisedProviderGroup } from './provider-group-orphan-guard'
import {
  acceptProviderWriterClose,
  closeProviderProcess,
  rootOnlyProviderClosePolicy,
  type ProviderProcessClosePolicy,
  type ProviderProcessCloseResult,
  type ProviderProcessTree
} from './provider-process-close'

const STDERR_TAIL_MAX_CHARS = 8192

export type ProviderProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
  processless: boolean
}

type ManagedProviderProcessOptions = {
  site: string
  /** Defaults to the root-only policy; only a provider with its own reaper overrides it. */
  policy?: (supervised: boolean) => ProviderProcessClosePolicy
  spawnImpl?: PipedProcessSpawner
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
  /** Defaults to accepting root exit or delivered writer termination without descendant proof. */
  acceptClose?: (result: ProviderProcessCloseResult) => boolean
  /** Defaults to `session`; a one-shot's stdin end completes its request instead of stopping it. */
  lifetime?: ProviderSupervisorLifetime
  onOutput?: () => void
  /** Each stderr line, `cut` past `stderrLineMaxChars`; true withholds it from the tail. */
  onStderrLine?: (line: string, cut: boolean) => boolean
  /** Classification prefix cap; independent of the retained stderr tail size. */
  stderrLineMaxChars?: number
}

export type ManagedProviderProcess = {
  child: PipedChildProcess
  supervised: boolean
  /** The spawn failed before a process existed: absence is proven, but no exit was observed. */
  readonly processless: boolean
  /** `exited` covers a processless child too; use `rootExitObserved` for "a real process exited". */
  readonly rootVerdict: DescendantTreeVerdict
  /** A process that existed was seen to exit; never true for a processless child. */
  readonly rootExitObserved: boolean
  /** Retained close evidence on this handle; a late root event keeps its earlier diagnostic. */
  readonly lastCloseResult: ProviderProcessCloseResult | null
  /** First exit observation, including processless spawn failure; null before either is observed. */
  readonly exitStatus: ProviderProcessExit | null
  readonly exitPromise: Promise<void>
  /** Direct or supervisor-reported ENOENT for the provider executable. */
  readonly executableMissing: boolean
  /** What that ENOENT proves absent; the working folder, not the CLI, when the cwd is gone. */
  readonly spawnAbsence: ProviderSpawnAbsence | null
  /** The last 8 KiB of stderr, which the managed process drains so the child never blocks on it. */
  stderrTail(): string
  onExit(listener: (exit: ProviderProcessExit) => void): void
  terminateTree(): Promise<ProviderProcessTeardownVerdict>
  close(tree?: ProviderProcessTree): Promise<ProviderProcessCloseResult>
  /** Writer retirement can finish while explicitly stricter tree cleanup remains retryable. */
  closeWriter(tree: ProviderProcessTree): Promise<ProviderProcessCloseResult>
}

export function spawnManagedProviderProcess(
  launch: ProviderProcessLaunch,
  options: ManagedProviderProcessOptions
): ManagedProviderProcess {
  const platform = options.platform ?? process.platform
  const closePolicy = options.policy ?? rootOnlyProviderClosePolicy
  const spec = createProviderSpawnSpec(launch, options.inheritedEnv ?? process.env, platform, {
    // Owner death must request the same close as an explicit provider close.
    closeRequest: closePolicy(true).signalSupervisorOnClose ? 'stdin-end-and-sigterm' : 'stdin-end',
    ...(options.lifetime ? { lifetime: options.lifetime } : {})
  })
  const policy = closePolicy(spec.supervised)
  if (spec.supervised && !(policy.gracefulExitMs >= PROVIDER_SUPERVISOR_MAX_STOP_MS)) {
    throw new RangeError(
      `Supervised provider graceful exit must wait at least ${PROVIDER_SUPERVISOR_MAX_STOP_MS} ms; received ${policy.gracefulExitMs} ms`
    )
  }
  const child = (options.spawnImpl ?? spawnProcess)({
    program: spec.program,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    detached: spec.detached,
    stdio: ['pipe', 'pipe', 'pipe', ...spec.groupReportStdio]
  })
  guardSupervisedProviderGroup(child, { site: options.site, supervised: spec.supervised })
  const listeners = new Set<(exit: ProviderProcessExit) => void>()
  let observed: ProviderProcessExit | null = null
  let spawnFailed = false
  let spawnError: unknown = null
  let lastCloseResult: ProviderProcessCloseResult | null = null
  const exitProof = new RetryableProcessExitProof(options.acceptClose ?? acceptProviderWriterClose)
  let stderrTail = ''
  let stderrLine = ''
  let lineCut = false
  const lineMaxChars = options.stderrLineMaxChars ?? STDERR_TAIL_MAX_CHARS
  // Drop truncated lines: an unclassified suffix may contain a private sign-in URL.
  const retainLine = (line: string, cut: boolean): void => {
    if (line && !options.onStderrLine?.(line, cut) && !cut) {
      stderrTail = `${stderrTail}${line}\n`.slice(-STDERR_TAIL_MAX_CHARS)
    }
  }
  // Drain stderr so a full pipe cannot block the child.
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    if (options.onStderrLine) {
      const lines = (stderrLine + chunk).split('\n')
      const pending = lines.pop() ?? ''
      // Keep the prompt prefix until the complete line can be classified.
      lines.forEach((line, index) => retainLine(line, index === 0 && lineCut))
      lineCut = (lines.length === 0 && lineCut) || pending.length > lineMaxChars
      stderrLine = pending.slice(0, lineMaxChars)
    } else {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS)
    }
    options.onOutput?.()
  })
  child.stderr.once('end', () => retainLine(stderrLine, lineCut))
  if (options.onOutput) {
    observeReaderOutput(child.stdout, options.onOutput)
  }
  let resolveExit = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const observeExit = (exit: ProviderProcessExit): void => {
    if (observed) {
      return
    }
    observed = exit
    resolveExit()
    for (const listener of listeners) {
      listener(exit)
    }
    listeners.clear()
  }
  child.on('exit', (code, signal) => observeExit({ code, signal, processless: false }))
  child.on('error', (error) => {
    spawnFailed ||= child.pid === undefined
    spawnError ??= error
  })
  child.on('close', (code, signal) => {
    const processless = spawnFailed && child.pid === undefined
    if (processless) {
      observeExit({ code, signal, processless })
    }
  })
  const rootVerdict = (): DescendantTreeVerdict =>
    observed ? 'exited' : child.pid === undefined ? 'unverifiable' : 'live'
  // Settled once a failure exists, so the cwd is stat'd at most once and only on failure.
  let absence: ProviderSpawnAbsence | null | undefined
  const spawnAbsence = (): ProviderSpawnAbsence | null => {
    if (absence !== undefined) {
      return absence
    }
    // A direct spawn error names what this process spawned: the supervisor, when there is one.
    if (spawnError) {
      const direct = providerSpawnAbsence(spawnError, spec.program, launch.cwd)
      // A missing supervisor is Orca's own binary (e.g. mid-update), never the agent's CLI.
      absence = spec.supervised && direct === 'executable' ? null : direct
      return absence
    }
    const reported = observed ? supervisedProviderSpawnFailure(observed.code, stderrTail) : null
    if (!reported) {
      return null
    }
    absence = providerSpawnAbsence(reported.error, launch.command, launch.cwd)
    return absence
  }
  const terminateTree = (): Promise<ProviderProcessTeardownVerdict> =>
    terminateProviderProcessTree(child, {
      site: options.site,
      platform,
      supervised: spec.supervised
    })

  const knownWriterClose = (tree?: ProviderProcessTree): ProviderProcessCloseResult | null => {
    if (!lastCloseResult?.killDelivered && tree?.killDelivered) {
      lastCloseResult = { root: rootVerdict(), tree: tree.treeVerdict, killDelivered: true }
    }
    return lastCloseResult?.killDelivered ? lastCloseResult : null
  }

  const close = (tree?: ProviderProcessTree): Promise<ProviderProcessCloseResult> =>
    exitProof.run(async () => {
      const known = knownWriterClose(tree)
      if (known && !options.acceptClose) {
        return known
      }
      if (observed && !tree) {
        const result: ProviderProcessCloseResult = { root: 'exited', tree: null }
        lastCloseResult ??= result
        return result
      }
      const result = await closeProviderProcess({
        child,
        exitPromise,
        rootVerdict,
        supervised: spec.supervised,
        policy,
        tree,
        terminateTree
      })
      lastCloseResult = {
        ...result,
        ...(lastCloseResult?.killDelivered || tree?.killDelivered ? { killDelivered: true } : {})
      }
      return lastCloseResult
    })

  return {
    child,
    supervised: spec.supervised,
    exitPromise,
    get exitStatus() {
      return observed
    },
    get processless() {
      return observed?.processless ?? false
    },
    get rootVerdict() {
      return rootVerdict()
    },
    get rootExitObserved() {
      return observed !== null && !observed.processless
    },
    get executableMissing() {
      return spawnAbsence() === 'executable'
    },
    get spawnAbsence() {
      return spawnAbsence()
    },
    stderrTail: () => stderrTail,
    get lastCloseResult() {
      return lastCloseResult
    },
    onExit(listener) {
      if (observed) {
        listener(observed)
      } else {
        listeners.add(listener)
      }
    },
    terminateTree,
    close,
    closeWriter(tree) {
      const known = knownWriterClose(tree)
      return known ? Promise.resolve(known) : close(tree)
    }
  }
}

/** A premature data listener would drain stdout before a late reader can subscribe. */
function observeReaderOutput(
  stdout: Pick<NodeJS.ReadableStream, 'on' | 'removeListener'>,
  onOutput: () => void
): void {
  const onSubscribe = (event: string | symbol): void => {
    if (event !== 'data' && event !== 'readable') {
      return
    }
    stdout.removeListener('newListener', onSubscribe)
    // newListener fires before registration; attach after the reader via a microtask.
    queueMicrotask(() => stdout.on('data', onOutput))
  }
  stdout.on('newListener', onSubscribe)
}
