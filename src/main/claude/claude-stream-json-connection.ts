import { createClaudeQueryOperation } from './claude-query-operation'
import type { ProviderReceiveDisposition } from '../provider-process/provider-source-completion'
import type {
  ClaudeStreamJsonLaunch,
  ClaudeStreamJsonConnectionHandlers,
  ClaudeChildExitVerdict,
  ClaudeCloseOutcome,
  ClaudeStreamJsonConnection
} from './claude-stream-json-connection-contract'
export type * from './claude-stream-json-connection-contract'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import {
  buildClaudeChildProcessEnv,
  deleteClaudeLaunchEnvKeys
} from './claude-child-process-environment'
import { withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'
import { withoutRejectedClaudeApiKey } from './claude-rejected-api-key'
import {
  ClaudeControlRequestError,
  createClaudeControlSurface
} from './claude-agent-sdk-control-requests'
import { createClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'
import { finishClaudeSdkReceive, readClaudeSdkMessages } from './claude-agent-sdk-receive'
export { CLAUDE_READER_DRAIN_AFTER_EXIT_MS } from './claude-agent-sdk-receive'
import { claudeChildCloseProven } from './claude-child-exit-proof-ladder'
import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import {
  claudeUnwrittenUserMessageError,
  createClaudeUserMessageQueue
} from './claude-agent-sdk-user-message-queue'
import { withProviderSpawnAbsence } from '../provider-process/provider-executable-missing'
import { claudeStreamJsonExitError } from './claude-stream-json-exit-error'

export { ClaudeControlRequestError }

/** Lazy import confines SDK executable-search env mutation and missing-package failures to structured Claude. */

let claudeAgentSdk: Promise<typeof ClaudeAgentSdk> | null = null

export function loadClaudeAgentSdk(): Promise<typeof ClaudeAgentSdk> {
  claudeAgentSdk ??= import('@anthropic-ai/claude-agent-sdk')
  return claudeAgentSdk
}

export async function openClaudeStreamJsonConnection(
  launch: ClaudeStreamJsonLaunch,
  handlers: ClaudeStreamJsonConnectionHandlers = {},
  spawnImpl: PipedProcessSpawner = spawnProcess,
  queryImpl?: typeof ClaudeAgentSdk.query
): Promise<ClaudeStreamJsonConnection> {
  const { query } = await loadClaudeAgentSdk()
  const spawner = createClaudeCodeProcessSpawn(spawnImpl, process.platform, launch)
  // Always supply scrubbed env to prevent ambient auth leaks; only launch.env may pin CLAUDE_CONFIG_DIR.
  const env = await withoutRejectedClaudeApiKey(
    deleteClaudeLaunchEnvKeys(
      buildClaudeChildProcessEnv(launch.env, {
        inheritedEnv: withoutInheritedClaudeConfigDir(process.env),
        scrubConfiguredChildSessionStamps: true
      }),
      launch.envToDelete ?? []
    )
  )
  const inbox = createClaudeUserMessageQueue()
  const operation = createClaudeQueryOperation(launch.account)
  const session = operation.capture(() =>
    (queryImpl ?? query)({
      prompt: inbox.messages,
      options: {
        ...launch.options,
        cwd: launch.cwd,
        env,
        pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
        spawnClaudeCodeProcess: spawner.spawn,
        processReceiveLifecycle: 'external',
        ...(handlers.canUseTool ? { canUseTool: handlers.canUseTool } : {}),
        ...(handlers.onUserDialog ? { onUserDialog: handlers.onUserDialog } : {})
      }
    })
  )
  const managed = spawner.managed
  const child = managed?.child
  if (!child || !managed) {
    throw new Error('the claude agent SDK returned without spawning a child')
  }
  operation.start(session, managed, spawner.inputDone)
  let closing = false
  let transportError: Error | null = null
  let faultReported = false
  let exitReported = false
  let closePromise: Promise<ClaudeCloseOutcome> | null = null
  let receiveResult: Promise<ProviderReceiveDisposition> | undefined
  let readingBarrier: Promise<void> | null = null
  let releaseReadingBarrier: (() => void) | null = null
  const unavailable = (): boolean =>
    closing || spawner.inputClosing || managed.rootVerdict === 'exited' || transportError !== null
  const pauseReading = (): void => {
    if (unavailable() || readingBarrier) {
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
  const tree = createClaudeChildTreeReaper(child, {
    exited: rootSettled,
    supervised: managed.supervised
  })

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
    if (!transportError) {
      const error = claudeStreamJsonExitError(managed.stderrTail(), managed.exitStatus, cause)
      transportError = withProviderSpawnAbsence(error, managed.spawnAbsence)
    }
    inbox.fail(transportError)
    if (!closing && !faultReported) {
      faultReported = true
      handlers.onFault?.(transportError)
    }
    if (managed.rootExitObserved && !exitReported) {
      exitReported = true
      handlers.onExit?.(transportError, { expected: closing })
    }
    void spawner.finishInput().catch((error: unknown) => {
      handlers.onFault?.(error instanceof Error ? error : new Error(String(error)))
    })
  }

  const receiveCompleted = session.receiveCompleted
  const readerDone = readClaudeSdkMessages({
    query: session,
    waitUntilReadable,
    onMessage: (message) => handlers.onMessage?.(message)
  }).catch((error: unknown) => {
    if (!closing && managed.rootVerdict !== 'exited') {
      void tree.reap()
    }
    handleUnexpectedEnd(error instanceof Error ? error : new Error(String(error)))
  })

  void spawner.inputDone.then(
    () => resumeReading(),
    (cause: unknown) => {
      handleUnexpectedEnd(cause instanceof Error ? cause : new Error(String(cause)))
      void managed.close()
    }
  )
  managed.onExit(() => handleUnexpectedEnd())
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
    if (unavailable() || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(
        claudeUnwrittenUserMessageError(
          transportError ?? new Error('claude stream-json connection is closed')
        )
      )
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch constructs the SDK user envelope after mapping every content block.
    return inbox.push(message as unknown as SDKUserMessage, beforeDispatch)
  }

  const exitVerdict = (): ClaudeChildExitVerdict => ({
    root: managed.rootVerdict,
    tree: tree.treeVerdict,
    ...(tree.killDelivered || managed.lastCloseResult?.killDelivered
      ? { killDelivered: true as const }
      : {}),
    ...(managed.processless ? { processless: true } : {})
  })
  const closeOutcome = (): Promise<ClaudeCloseOutcome> => {
    if (closePromise) {
      return closePromise
    }
    const attempt = (async (): Promise<ClaudeCloseOutcome> => {
      closing = true
      managed.abandonLaunchObservation()
      resumeReading()
      await (tree.refresh?.() ?? tree.capture())
      inbox.end()
      const result = await managed.closeWriter(tree)
      const accepted = claudeChildCloseProven(result) || result.killDelivered === true
      inbox.fail(new Error('claude stream-json connection closed'))
      if (!accepted && result.root === 'exited' && result.tree === 'live') {
        console.warn('[claude-stream-json] root exited but a descendant survived the close:', {
          pid: spawner.pid
        })
      }
      let receive: ProviderReceiveDisposition = { state: 'retained' }
      if (accepted || spawner.inputClosing) {
        receiveResult ??= finishClaudeSdkReceive({
          finishInput: spawner.finishInput,
          receivedInput: () => spawner.receivedInput,
          receiveCompleted,
          readerDone,
          externalContractRequired: !queryImpl || queryImpl === query,
          onFault: handlers.onFault
        }).then(
          () => ({ state: 'complete' as const }),
          (error: unknown) => ({ state: 'failed' as const, error })
        )
        receive = await receiveResult
      }
      return { accepted, physical: exitVerdict(), receive }
    })()
    closePromise = attempt
    void attempt.then(
      (outcome) => {
        if (!outcome.accepted && closePromise === attempt) {
          closePromise = null
        }
      },
      () => {
        if (closePromise === attempt) {
          closePromise = null
        }
      }
    )
    return attempt
  }
  const close = async (): Promise<boolean> => {
    const outcome = await closeOutcome()
    if (outcome.receive.state === 'failed') {
      throw outcome.receive.error
    }
    return outcome.accepted
  }

  return {
    ...createClaudeControlSurface(session, () =>
      unavailable()
        ? (transportError ?? new Error('claude stream-json connection is closed'))
        : null
    ),
    initializationResult: () => operation.result,
    get transportError() {
      return transportError
    },
    get startupFailure() {
      return operation.failure
    },
    startupSettled: () =>
      operation.result.then(
        () => {},
        () => {}
      ),
    rejectStartup: operation.reject,
    get pid() {
      return spawner.pid
    },
    get closed() {
      return unavailable()
    },
    get executableMissing() {
      return managed.executableMissing
    },
    get exitVerdict() {
      return exitVerdict()
    },
    pauseReading,
    resumeReading,
    send,
    closeOutcome,
    close
  }
}
