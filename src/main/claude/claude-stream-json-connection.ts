import { randomUUID } from 'node:crypto'
import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type { CanUseTool, OnUserDialog, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '../../shared/child-process/run-process'
import {
  markClaudeStructuredChildExited,
  markClaudeStructuredChildSpawned
} from '../claude-accounts/live-pty-gate'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import { withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'
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

export { ClaudeControlRequestError }

/** How long a proven close waits for messages already written before the exit; whatever still
 *  holds the output open past it is no reason to keep the close unresolved. */
export const CLAUDE_READER_DRAIN_AFTER_EXIT_MS = 2_000

/**
 * The SDK is loaded at the structured-Claude boundary rather than by this module's
 * import. The ordinary runtime's class graph statically reaches this file, and the
 * SDK sets `process.env.NoDefaultCurrentDirectoryInExePath` at import time — a
 * Windows executable-search change that a user who never leaves the terminal/TUI
 * path never opted into, and a missing SDK would fail runtime startup. Memoized,
 * so a session pays the import once per process rather than once per connection.
 */

let claudeAgentSdk: Promise<typeof ClaudeAgentSdk> | null = null

function loadClaudeAgentSdk(): Promise<typeof ClaudeAgentSdk> {
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
}

export type ClaudeStreamJsonConnectionHandlers = {
  onMessage?: (message: Record<string, unknown>) => void
  /**
   * The SDK owns inbound permission control: it hands `can_use_tool` to this callback with
   * a stable requestId and an abort signal, dedups duplicate delivery, and matches the
   * response by request_id itself. Setting it makes the SDK pass `--permission-prompt-tool
   * stdio` automatically; it must not be paired with `permissionPromptToolName`.
   */
  canUseTool?: CanUseTool
  /** `request_user_dialog` control; the CLI only emits kinds declared in `supportedDialogKinds`. */
  onUserDialog?: OnUserDialog
  /** A transport/process fault that is not itself first-hand root exit proof. */
  onFault?: (error: Error) => void
  /** The root process exited, reported once. `expected`: a close had begun, so it is that close's
   *  end, even one that ran out of its own escalation first and came back unproven. */
  onExit?: (error: Error, exit?: { expected: boolean }) => void
}

/**
 * Two questions with their own evidence. The root's verdict is first-hand: Orca's
 * own child handle reported exit, or reported error then close before it ever had
 * a pid. The tree's comes from bounded descendant verification, and `unverifiable`
 * is never collapsed into either neighbour.
 */
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
  pauseReading?: () => void
  resumeReading?: () => void
  send: (message: Record<string, unknown>, beforeDispatch?: () => Promise<void>) => Promise<void>
  /** Resolves true after processless settlement, or root exit plus observed tree exit. */
  close: () => Promise<boolean>
}

type ExitStatus = { code: number | null; signal: NodeJS.Signals | null }

function exitError(stderrTail: string, status: ExitStatus | null, cause?: Error): Error {
  const detail = stderrTail.trim()
  // The status is the diagnostic a signed-out or refused start leaves behind;
  // it has to survive every wrapper between here and the user.
  const how =
    status?.signal !== null && status?.signal !== undefined
      ? ` (signal ${status.signal})`
      : status?.code !== null && status?.code !== undefined
        ? ` (code ${status.code})`
        : ''
  const message = `claude stream-json exited${how}${detail ? `: ${detail}` : ''}`
  // Written for a log, not a person: the chat keeps it behind Details.
  const diagnostic = providerDiagnostic([how.trim(), detail].filter(Boolean).join('\n'), 'log')
  return withProviderDiagnostic(
    cause ? new Error(message, { cause }) : new Error(message),
    diagnostic
  )
}

export async function openClaudeStreamJsonConnection(
  launch: ClaudeStreamJsonLaunch,
  handlers: ClaudeStreamJsonConnectionHandlers = {},
  spawnImpl: typeof spawnProcess = spawnProcess,
  queryImpl?: typeof ClaudeAgentSdk.query
): Promise<ClaudeStreamJsonConnection> {
  const { query } = await loadClaudeAgentSdk()
  const spawner = createClaudeCodeProcessSpawn(spawnImpl)
  const inbox = createClaudeUserMessageQueue()
  const session = (queryImpl ?? query)({
    prompt: inbox.messages,
    options: {
      ...launch.options,
      cwd: launch.cwd,
      // Why env is never omitted: the SDK inherits process.env when it is, which is
      // exactly the ambient ANTHROPIC_* auth leak this lane already shipped once.
      // Orca's own CLAUDE_CONFIG_DIR is dropped for the same reason the launch drops the
      // shell's: the record's pin in `launch.env` must be the only home the child sees.
      env: buildClaudeChildProcessEnv(launch.env, {
        inheritedEnv: withoutInheritedClaudeConfigDir(process.env),
        scrubConfiguredChildSessionStamps: true
      }),
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
  // This child owns the account's credentials for as long as it runs, exactly as a
  // Claude PTY does — hold the OAuth-refresh gate so a managed refresh cannot rotate
  // the single-use token out from under it mid-turn. Entered below, once a release
  // path exists.
  const authGateKey = randomUUID()
  const releaseAuthGate = (): void => markClaudeStructuredChildExited(authGateKey)
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
  // One reaper per child: every close attempt and error-path reap shares its proof.
  const rootSettled = (): boolean => managed.rootVerdict === 'exited'
  const tree = createClaudeChildTreeReaper(child, { exited: rootSettled })

  // Arm lazily on actual child output instead of issuing a process-table scan for
  // every session at startup. A natural SDK exit can race a later close, while
  // output-triggered observation still catches the usual live-child window.
  let outputObservationArmed = false
  const armTreeOnOutput = (): void => {
    if (outputObservationArmed) {
      return
    }
    outputObservationArmed = true
    void (tree.refresh?.() ?? tree.capture())
  }
  child.stderr.on('data', armTreeOnOutput)
  // The SDK may synchronously spawn the CLI and consume an early stderr chunk
  // before this connection can attach its listener; the bounded tail preserves
  // that observation for the same lazy arm.
  if (managed.stderrTail().length > 0) {
    armTreeOnOutput()
  }

  const handleUnexpectedEnd = (cause?: Error): void => {
    resumeReading()
    terminalError ??= exitError(managed.stderrTail(), exitStatus, cause)
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
      // The SDK ends its generator in error when the child dies or the transport
      // fails; a transport failure with a live child still has to reap the tree.
      if (!closing && managed.rootVerdict !== 'exited') {
        void tree.reap()
      }
      handleUnexpectedEnd(error instanceof Error ? error : new Error(String(error)))
    }
  })()

  managed.onExit((exit) => {
    exitStatus = exit
    releaseAuthGate()
    handleUnexpectedEnd()
  })
  child.on('error', (error) => {
    if (!closing && managed.rootVerdict !== 'exited') {
      void tree.reap()
    }
    handleUnexpectedEnd(error)
  })
  child.on('close', () => {
    releaseAuthGate()
    handleUnexpectedEnd()
  })
  child.stdin.on('error', (error) => {
    if (!closing) {
      void tree.reap()
      handleUnexpectedEnd(error)
    }
  })
  // Why here and not at spawn: a structured gate entry is deliberately unpersisted, so
  // confirmSeededClaudeLivePtys can never reconcile a stray one and a leak defers the
  // managed OAuth refresh for the life of the process. Entering only after 'exit' and
  // 'close' are attached makes that unreachable — any later throw still leaves a
  // listener that releases. Nothing between spawn and here can yield, so the child
  // cannot end before the gate is entered.
  markClaudeStructuredChildSpawned(authGateKey)

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
      // Arm the descendant proof before the stop. The root may exit immediately;
      // a post-exit walk cannot recover descendants that reparented.
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
