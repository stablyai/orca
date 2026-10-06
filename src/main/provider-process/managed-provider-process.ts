import { spawnProcess } from '../../shared/child-process/run-process'
import { RetryableProcessExitProof } from '../../shared/child-process/retryable-process-exit-proof'
import type { ProviderProcessLaunch } from './provider-process-launch'
import {
  PROVIDER_SUPERVISOR_MAX_STOP_MS,
  createProviderSpawnSpec
} from './provider-process-supervisor'
import {
  terminateProviderProcessTree,
  type ProviderProcessTeardownVerdict
} from './provider-process-teardown'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import {
  acceptProviderRootExit,
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
  spawnImpl?: typeof spawnProcess
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
  /** Defaults to "the root is gone". */
  acceptClose?: (result: ProviderProcessCloseResult) => boolean
}

export type ManagedProviderProcess = {
  child: ReturnType<typeof spawnProcess>
  supervised: boolean
  /** The spawn failed before a process existed: absence is proven, but no exit was observed. */
  readonly processless: boolean
  /** `exited` covers a processless child too; use `rootExitObserved` for "a real process exited". */
  readonly rootVerdict: DescendantTreeVerdict
  /** A process that existed was seen to exit; never true for a processless child. */
  readonly rootExitObserved: boolean
  /** The last close that ran the ladder; the already-exited answer only when none did. */
  readonly lastCloseResult: ProviderProcessCloseResult | null
  readonly exitPromise: Promise<void>
  /** The last 8 KiB of stderr, which the managed process drains so the child never blocks on it. */
  stderrTail(): string
  onExit(listener: (exit: ProviderProcessExit) => void): void
  terminateTree(): Promise<ProviderProcessTeardownVerdict>
  close(tree?: ProviderProcessTree): Promise<ProviderProcessCloseResult>
}

/** One child owns its exit observation and every retry of an unconfirmed close. */
export function spawnManagedProviderProcess(
  launch: ProviderProcessLaunch,
  options: ManagedProviderProcessOptions
): ManagedProviderProcess {
  const platform = options.platform ?? process.platform
  const spec = createProviderSpawnSpec(launch, options.inheritedEnv ?? process.env, platform)
  const policy = (options.policy ?? rootOnlyProviderClosePolicy)(spec.supervised)
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
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const listeners = new Set<(exit: ProviderProcessExit) => void>()
  let observed: ProviderProcessExit | null = null
  let spawnFailed = false
  let lastCloseResult: ProviderProcessCloseResult | null = null
  const exitProof = new RetryableProcessExitProof(options.acceptClose ?? acceptProviderRootExit)
  let stderrTail = ''
  // An undrained stderr pipe blocks the child once it fills.
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_CHARS)
  })
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
  child.on('error', () => {
    spawnFailed ||= child.pid === undefined
  })
  child.on('close', (code, signal) => {
    const processless = spawnFailed && child.pid === undefined
    if (processless) {
      observeExit({ code, signal, processless })
    }
  })
  const rootVerdict = (): DescendantTreeVerdict =>
    observed ? 'exited' : child.pid === undefined ? 'unverifiable' : 'live'
  const terminateTree = (): Promise<ProviderProcessTeardownVerdict> =>
    terminateProviderProcessTree(child, { site: options.site, platform })

  return {
    child,
    supervised: spec.supervised,
    exitPromise,
    get processless() {
      return observed?.processless ?? false
    },
    get rootVerdict() {
      return rootVerdict()
    },
    get rootExitObserved() {
      return observed !== null && !observed.processless
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
    close(tree) {
      return exitProof.run(async () => {
        // The one already-exited guard. It observed nothing, so an earlier close's findings stay.
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
        lastCloseResult = result
        return result
      })
    }
  }
}
