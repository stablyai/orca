import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type { CanUseTool, OnUserDialog, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import { withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'
import { withoutRejectedClaudeApiKey } from './claude-rejected-api-key'
import {
  ClaudeControlRequestError,
  createClaudeControlSurface,
  type ClaudeControlSurface
} from './claude-agent-sdk-control-requests'
import { createClaudeChildTreeReaper, proveClaudeChildExit } from './claude-agent-sdk-exit-proof'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import {
  claudeUnwrittenUserMessageError,
  createClaudeUserMessageQueue
} from './claude-agent-sdk-user-message-queue'
import type { ClaudeStructuredSdkOptions } from './claude-structured-launch-resolution'
import { providerStderrForDisplay } from '../provider-process/provider-spawn-failure-report'
import { withMissingProviderExecutable } from '../provider-process/provider-executable-missing'

export { ClaudeControlRequestError }

/** Bound output draining after proven exit so inherited pipes cannot hold close open. */
export const CLAUDE_READER_DRAIN_AFTER_EXIT_MS = 2_000

/** Lazy import confines SDK executable-search env mutation and missing-package failures to structured Claude. */

let claudeAgentSdk: Promise<typeof ClaudeAgentSdk> | null = null

export function loadClaudeAgentSdk(): Promise<typeof ClaudeAgentSdk> {
  claudeAgentSdk ??= import('@anthropic-ai/claude-agent-sdk')
  return claudeAgentSdk
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export type ClaudeStreamJsonLaunch = {
  /** Orca's resolved user CLI; the SDK falls back to a bundled binary that is not installed. */
  pathToClaudeCodeExecutable: string
  options: ClaudeStructuredSdkOptions
  cwd: string
  env?: Record<string, string>
  /** Delete these keys after merging inherited and launch env. */
  envToDelete?: readonly string[]
}

function withoutKeys(env: Record<string, string>, keys: readonly string[]): Record<string, string> {
  for (const key of keys) {
    delete env[key]
  }
  return env
}

export type ClaudeStreamJsonConnectionHandlers = {
  onMessage?: (message: Record<string, unknown>) => void
  /** The SDK handles request IDs, aborts and deduplication; cannot combine with permissionPromptToolName. */
  canUseTool?: CanUseTool
  /** `request_user_dialog` control; the CLI only emits kinds declared in `supportedDialogKinds`. */
  onUserDialog?: OnUserDialog
  /** A transport/process fault that is not itself first-hand root exit proof. */
  onFault?: (error: Error) => void
  /** Report observed root exit once; expected stays true even after an unproven close attempt. */
  onExit?: (error: Error, exit?: { expected: boolean }) => void
}

/** Root proof comes from our child handle or processless settlement; tree proof is independently verified. */
export type ClaudeChildExitVerdict = {
  root: DescendantTreeVerdict
  tree: DescendantTreeVerdict
  processless?: boolean
}

export type ClaudeStreamJsonConnection = ClaudeControlSurface & {
  readonly pid: number | undefined
  readonly closed: boolean
  /** What the ladder has observed so far; read after a `close()` that returned false. */
  readonly exitVerdict: ClaudeChildExitVerdict
  readonly executableMissing?: boolean
  pauseReading?: () => void
  resumeReading?: () => void
  send: (message: Record<string, unknown>, beforeDispatch?: () => Promise<void>) => Promise<void>
  /** Resolves true after processless settlement, or root exit plus observed tree exit. */
  close: () => Promise<boolean>
}

type ExitStatus = { code: number | null; signal: NodeJS.Signals | null }

function exitError(stderrTail: string, status: ExitStatus | null, cause?: Error): Error {
  const detail = providerStderrForDisplay(stderrTail).trim()
  // Retain exit status and stderr through wrappers for refused-start diagnostics.
  const how =
    status?.signal !== null && status?.signal !== undefined
      ? ` (signal ${status.signal})`
      : status?.code !== null && status?.code !== undefined
        ? ` (code ${status.code})`
        : ''
  const message = `claude stream-json exited${how}${detail ? `: ${detail}` : ''}`
  const diagnostic = providerDiagnostic([how.trim(), detail].filter(Boolean).join('\n'), 'log')
  return withProviderDiagnostic(
    cause ? new Error(message, { cause }) : new Error(message),
    diagnostic
  )
}

export async function openClaudeStreamJsonConnection(
  launch: ClaudeStreamJsonLaunch,
  handlers: ClaudeStreamJsonConnectionHandlers = {},
  spawnImpl: PipedProcessSpawner = spawnProcess,
  queryImpl?: typeof ClaudeAgentSdk.query
): Promise<ClaudeStreamJsonConnection> {
  const { query } = await loadClaudeAgentSdk()
  const spawner = createClaudeCodeProcessSpawn(spawnImpl, process.platform)
  // Always supply scrubbed env to prevent ambient auth leaks; only launch.env may pin CLAUDE_CONFIG_DIR.
  const env = await withoutRejectedClaudeApiKey(
    withoutKeys(
      buildClaudeChildProcessEnv(launch.env, {
        inheritedEnv: withoutInheritedClaudeConfigDir(process.env),
        scrubConfiguredChildSessionStamps: true
      }),
      launch.envToDelete ?? []
    )
  )
  const inbox = createClaudeUserMessageQueue()
  const session = (queryImpl ?? query)({
    prompt: inbox.messages,
    options: {
      ...launch.options,
      cwd: launch.cwd,
      env,
      pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess: spawner.spawn,
      ...(handlers.canUseTool ? { canUseTool: handlers.canUseTool } : {}),
      ...(handlers.onUserDialog ? { onUserDialog: handlers.onUserDialog } : {})
    }
  })
  const managed = spawner.managed
  const child = managed?.child
  if (!child || !managed) {
    throw new Error('the claude agent SDK returned without spawning a child')
  }
  let exitStatus: ExitStatus | null = null
  let closing = false
  let terminalError: Error | null = null
  let faultReported = false
  let exitReported = false
  let closePromise: Promise<boolean> | null = null
  let readingBarrier: Promise<void> | null = null
  let releaseReadingBarrier: (() => void) | null = null
  const pauseReading = (): void => {
    if (closing || managed.rootVerdict === 'exited' || terminalError || readingBarrier) {
      return
    }
    readingBarrier = new Promise<void>((resolve) => {
      releaseReadingBarrier = resolve
    })
  }
  const resumeReading = (): void => {
    const release = releaseReadingBarrier
    readingBarrier = null
    releaseReadingBarrier = null
    release?.()
  }
  const waitUntilReadable = (): Promise<void> => readingBarrier ?? Promise.resolve()
  // Share descendant evidence across close retries and fault cleanup.
  const rootSettled = (): boolean => managed.rootVerdict === 'exited'
  const tree = createClaudeChildTreeReaper(child, { exited: rootSettled })

  // Observe descendants on first output to avoid startup scans while still catching natural-exit races.
  let outputObservationArmed = false
  const armTreeOnOutput = (): void => {
    if (outputObservationArmed) {
      return
    }
    outputObservationArmed = true
    void (tree.refresh?.() ?? tree.capture())
  }
  child.stderr.on('data', armTreeOnOutput)
  // The SDK may consume early stderr synchronously; its bounded tail preserves that observation.
  if (managed.stderrTail().length > 0) {
    armTreeOnOutput()
  }

  const handleUnexpectedEnd = (cause?: Error): void => {
    resumeReading()
    if (!terminalError) {
      const error = exitError(managed.stderrTail(), exitStatus, cause)
      terminalError = managed.executableMissing ? withMissingProviderExecutable(error) : error
    }
    inbox.fail(terminalError)
    if (!closing && !faultReported) {
      faultReported = true
      handlers.onFault?.(terminalError)
    }
    if (managed.rootExitObserved && !exitReported) {
      exitReported = true
      handlers.onExit?.(terminalError, { expected: closing })
    }
  }

  const readerDone = (async () => {
    try {
      const iterator = session[Symbol.asyncIterator]()
      let completed = false
      try {
        for (;;) {
          await waitUntilReadable()
          const next = await iterator.next()
          if (next.done) {
            completed = true
            break
          }
          await waitUntilReadable()
          if (!isRecord(next.value)) {
            throw new Error('claude stream-json yielded a non-object message')
          }
          handlers.onMessage?.(next.value)
        }
      } finally {
        if (!completed) {
          await iterator.return?.()
        }
      }
    } catch (error: unknown) {
      // Transport failure can leave the child alive, requiring a tree reap.
      if (!closing && managed.rootVerdict !== 'exited') {
        void tree.reap()
      }
      handleUnexpectedEnd(error instanceof Error ? error : new Error(String(error)))
    }
  })()

  managed.onExit((exit) => {
    exitStatus = exit
    handleUnexpectedEnd()
  })
  child.on('error', (error) => {
    if (!closing && managed.rootVerdict !== 'exited') {
      void tree.reap()
    }
    handleUnexpectedEnd(error)
  })
  child.on('close', () => {
    handleUnexpectedEnd()
  })
  child.stdin.on('error', (error) => {
    if (!closing) {
      void tree.reap()
      handleUnexpectedEnd(error)
    }
  })

  const send: ClaudeStreamJsonConnection['send'] = (message, beforeDispatch) => {
    if (
      closing ||
      managed.rootVerdict === 'exited' ||
      terminalError ||
      child.stdin.destroyed ||
      !child.stdin.writable
    ) {
      return Promise.reject(
        claudeUnwrittenUserMessageError(
          terminalError ?? new Error('claude stream-json connection is closed')
        )
      )
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch constructs the SDK user envelope after mapping every content block.
    return inbox.push(message as unknown as SDKUserMessage, beforeDispatch)
  }

  const close = (): Promise<boolean> => {
    closePromise ??= (async () => {
      closing = true
      resumeReading()
      // Capture before stopping: exited roots can leave reparented descendants undiscoverable.
      await (tree.refresh?.() ?? tree.capture())
      inbox.end()
      const proven = await proveClaudeChildExit({
        tree,
        managed
      })
      inbox.fail(new Error('claude stream-json connection closed'))
      if (!proven) {
        if (managed.lastCloseResult?.root === 'exited' && managed.lastCloseResult.tree === 'live') {
          console.warn('[claude-stream-json] root exited but a descendant survived the close:', {
            pid: spawner.pid
          })
        }
        closePromise = null
        return false
      }
      const drained = await withTimeout(
        readerDone.then(() => true),
        CLAUDE_READER_DRAIN_AFTER_EXIT_MS,
        false
      )
      if (!drained) {
        console.warn('[claude-stream-json] output still open after the proven exit:', {
          pid: spawner.pid
        })
      }
      return true
    })()
    return closePromise
  }

  return {
    ...createClaudeControlSurface(session),
    get pid() {
      return spawner.pid
    },
    get closed() {
      return closing || managed.rootVerdict === 'exited' || terminalError !== null
    },
    get executableMissing() {
      return managed.executableMissing
    },
    get exitVerdict() {
      return {
        root: managed.rootVerdict,
        tree: tree.treeVerdict,
        ...(managed.processless ? { processless: true } : {})
      } as const
    },
    pauseReading,
    resumeReading,
    send,
    close
  }
}
