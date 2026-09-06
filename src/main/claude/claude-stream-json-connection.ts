import { randomUUID } from 'node:crypto'
import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type { CanUseTool, OnUserDialog, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '../../shared/child-process/run-process'
import {
  markClaudeStructuredChildExited,
  markClaudeStructuredChildSpawned
} from '../claude-accounts/live-pty-gate'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import {
  ClaudeControlRequestError,
  createClaudeControlSurface,
  type ClaudeControlSurface
} from './claude-agent-sdk-control-requests'
import { createClaudeChildTreeReaper, proveClaudeChildExit } from './claude-agent-sdk-exit-proof'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import { createClaudeUserMessageQueue } from './claude-agent-sdk-user-message-queue'
import type { ClaudeStructuredSdkOptions } from './claude-structured-launch-resolution'

export { ClaudeControlRequestError }

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
  onExit?: (error: Error) => void
}

/**
 * Two questions with their own evidence. The root's verdict is first-hand: Orca's
 * own child handle reported exit, or reported error then close before it ever had
 * a pid. The tree's comes from bounded descendant verification, and `unverifiable`
 * is never collapsed into either neighbour.
 */
export type ClaudeChildExitVerdict = {
  root: 'exited' | 'live' | 'processless'
  tree: DescendantTreeVerdict
}

export type ClaudeStreamJsonConnection = ClaudeControlSurface & {
  readonly pid: number | undefined
  readonly closed: boolean
  /** What the ladder has observed so far; read after a `close()` that returned false. */
  readonly exitVerdict: ClaudeChildExitVerdict
  send: (message: Record<string, unknown>) => Promise<void>
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
  return cause ? new Error(message, { cause }) : new Error(message)
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
      env: buildClaudeChildProcessEnv(launch.env, { scrubConfiguredChildSessionStamps: true }),
      pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess: spawner.spawn,
      ...(handlers.canUseTool ? { canUseTool: handlers.canUseTool } : {}),
      ...(handlers.onUserDialog ? { onUserDialog: handlers.onUserDialog } : {})
    }
  })
  const child = spawner.child
  if (!child) {
    throw new Error('the claude agent SDK returned without spawning a child')
  }
  // This child owns the account's credentials for as long as it runs, exactly as a
  // Claude PTY does — hold the OAuth-refresh gate so a managed refresh cannot rotate
  // the single-use token out from under it mid-turn. Entered below, once a release
  // path exists.
  const authGateKey = randomUUID()
  const releaseAuthGate = (): void => markClaudeStructuredChildExited(authGateKey)
  let exited = false
  let exitStatus: ExitStatus | null = null
  let closing = false
  let processless = false
  let prePidSpawnError = false
  let terminalError: Error | null = null
  let faultReported = false
  let exitReported = false
  let closePromise: Promise<boolean> | null = null
  // One reaper per child: every close attempt and error-path reap shares its proof.
  const rootSettled = (): boolean => exited || processless
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
  if (spawner.stderrTail.length > 0) {
    armTreeOnOutput()
  }

  let settleExit = (): void => {}
  const exitPromise = new Promise<void>((resolve) => {
    settleExit = resolve
  })
  const markExited = (): void => {
    exited = true
    releaseAuthGate()
    settleExit()
  }
  child.on('exit', (code, signal) => {
    exitStatus = { code, signal }
    markExited()
    handleUnexpectedEnd()
  })

  const handleUnexpectedEnd = (cause?: Error): void => {
    terminalError ??= exitError(spawner.stderrTail, exitStatus, cause)
    inbox.fail(terminalError)
    if (!closing && !faultReported) {
      faultReported = true
      handlers.onFault?.(terminalError)
    }
    if (!closing && exited && !exitReported) {
      exitReported = true
      handlers.onExit?.(terminalError)
    }
  }

  void (async () => {
    for await (const message of session) {
      handlers.onMessage?.(message as unknown as Record<string, unknown>)
    }
  })().catch((error: unknown) => {
    // The SDK ends its generator in error when the child dies or the transport
    // fails; a transport failure with a live child still has to reap the tree.
    if (!closing && !exited) {
      void tree.reap()
    }
    handleUnexpectedEnd(error instanceof Error ? error : new Error(String(error)))
  })

  child.on('error', (error) => {
    if (spawner.pid === undefined) {
      prePidSpawnError = true
    }
    if (!closing && !exited) {
      void tree.reap()
    }
    handleUnexpectedEnd(error)
  })
  child.on('close', () => {
    // Covers the spawn-failure path too, where no 'exit' ever arrives.
    releaseAuthGate()
    if (prePidSpawnError && spawner.pid === undefined) {
      processless = true
      settleExit()
    }
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

  const send = (message: Record<string, unknown>): Promise<void> => {
    if (closing || exited || terminalError || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(terminalError ?? new Error('claude stream-json connection is closed'))
    }
    return inbox.push(message as unknown as SDKUserMessage)
  }

  const close = (): Promise<boolean> => {
    closePromise ??= (async () => {
      closing = true
      // Arm the descendant proof before ending stdin. The SDK may exit the root
      // immediately; a post-exit walk cannot recover descendants that reparented.
      await (tree.refresh?.() ?? tree.capture())
      inbox.end()
      const proven = await proveClaudeChildExit({
        child,
        exitPromise,
        exited: rootSettled,
        tree
      })
      inbox.fail(new Error('claude stream-json connection closed'))
      if (!proven) {
        closePromise = null
      }
      return proven
    })()
    return closePromise
  }

  return {
    ...createClaudeControlSurface(session),
    get pid() {
      return spawner.pid
    },
    get closed() {
      return closing || exited || terminalError !== null
    },
    get exitVerdict() {
      return {
        root: processless ? 'processless' : exited ? 'exited' : 'live',
        tree: tree.treeVerdict
      } as const
    },
    send,
    close
  }
}
