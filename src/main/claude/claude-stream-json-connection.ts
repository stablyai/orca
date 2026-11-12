import { withOrcaClaudeChatEntrypoint } from '../../shared/agent-launch/startup/claude-chat-entrypoint'
import { claudeStartupAnswerObservation } from './child-process/claude-startup-answer-observation'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import { buildClaudeChildProcessEnv } from './child-process/claude-child-process-environment'
import { withoutInheritedClaudeConfigDir } from './structured/launch/claude-config-dir-pin'
import { withoutRejectedClaudeApiKey } from './configuration/claude-rejected-api-key'
import { createClaudeControlSurface } from './sdk-transport/claude-agent-sdk-control-requests'
import { createClaudeChildTreeReaper } from './child-process/claude-agent-sdk-exit-proof'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { claudeChildCloseProven } from './child-process/claude-child-exit-proof-ladder'
import { createClaudeCodeProcessSpawn } from './child-process/claude-agent-sdk-process-spawn'
import {
  claudeUnwrittenUserMessageError,
  createClaudeUserMessageQueue
} from './sdk-transport/claude-agent-sdk-user-message-queue'
import { withProviderSpawnAbsence } from '../provider-process/provider-executable-missing'
import { claudeStreamJsonExitError } from './sdk-transport/claude-stream-json-exit-error'
import { withObservedProviderExit } from '../native-chat/agent-session-wire/startup/structured-agent-session-failure-text'
import type { ProviderProcessCloseOptions } from '../provider-process/provider-process-close'
import { createClaudeAdvisoryControls } from './structured/claude-advisory-controls'

import type * as connection from './claude-stream-json-connection-types'
export type * from './claude-stream-json-connection-types'

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

function withoutKeys(env: Record<string, string>, keys: readonly string[]): Record<string, string> {
  for (const key of keys) {
    delete env[key]
  }
  return env
}

export async function openClaudeStreamJsonConnection(
  launch: connection.ClaudeStreamJsonLaunch,
  handlers: connection.ClaudeStreamJsonConnectionHandlers = {},
  spawnImpl: PipedProcessSpawner = spawnProcess,
  queryImpl?: typeof ClaudeAgentSdk.query
): Promise<connection.ClaudeStreamJsonConnection> {
  const sdk = await loadClaudeAgentSdk()
  const startup = claudeStartupAnswerObservation(handlers.onStdout)
  const spawner = createClaudeCodeProcessSpawn(spawnImpl, process.platform, launch, startup.feed)
  // Always supply scrubbed env to prevent ambient auth leaks; only launch.env may pin CLAUDE_CONFIG_DIR.
  const env = await withoutRejectedClaudeApiKey(
    withoutKeys(
      buildClaudeChildProcessEnv(launch.env, {
        inheritedEnv: withoutInheritedClaudeConfigDir(process.env)
      }),
      launch.envToDelete ?? []
    )
  )
  const inbox = createClaudeUserMessageQueue()
  const advisory = launch.advisoryPolicy
    ? createClaudeAdvisoryControls(
        launch.advisoryPolicy,
        sdk,
        launch.options,
        handlers.onAdvisoryReport
      )
    : undefined
  const session = (queryImpl ?? sdk.query)({
    prompt: inbox.messages,
    options: {
      ...(advisory?.options ?? launch.options),
      cwd: launch.cwd,
      env: withOrcaClaudeChatEntrypoint(env, process.platform),
      pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
      spawnClaudeCodeProcess: spawner.spawn,
      ...(!advisory && handlers.canUseTool ? { canUseTool: handlers.canUseTool } : {}),
      ...(!advisory && handlers.onUserDialog ? { onUserDialog: handlers.onUserDialog } : {})
    }
  })
  const managed = spawner.managed
  const child = managed?.child
  if (!child || !managed) {
    throw new Error('the claude agent SDK returned without spawning a child')
  }
  const exited = Promise.withResolvers<Error>()
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
  const tree = createClaudeChildTreeReaper(child, {
    site: 'claude-structured-child-close',
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
    advisory?.end()
    resumeReading()
    if (!terminalError) {
      const error = claudeStreamJsonExitError(managed.stderrTail(), managed.exitStatus, cause)
      terminalError = withProviderSpawnAbsence(error, managed.spawnAbsence)
    }
    // One physical exit reaches both callbacks; mark it first so onFault cannot treat it as live-root.
    if (managed.rootExitObserved && !closing) {
      withObservedProviderExit(terminalError)
    }
    inbox.fail(terminalError)
    if (!closing && !faultReported) {
      faultReported = true
      handlers.onFault?.(terminalError)
    }
    if (managed.rootExitObserved && !exitReported) {
      exitReported = true
      handlers.onExit?.(terminalError, { expected: closing })
      exited.resolve(terminalError)
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

  const send: connection.ClaudeStreamJsonConnection['send'] = (message, beforeDispatch) => {
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
    const refused = advisory?.admitInput()
    if (refused) {
      return Promise.reject(refused)
    }
    startup.finish()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch constructs the SDK user envelope after mapping every content block.
    return inbox.push(
      message as unknown as SDKUserMessage,
      advisory
        ? () => advisory.beforeWrite(() => session.initializationResult(), beforeDispatch)
        : beforeDispatch
    )
  }

  const close = (options?: ProviderProcessCloseOptions): Promise<boolean> => {
    closePromise ??= (async () => {
      closing = true
      advisory?.end()
      resumeReading()
      // Capture before stopping: exited roots can leave reparented descendants undiscoverable.
      await (tree.refresh?.() ?? tree.capture())
      inbox.end()
      const result = await managed.closeWriter(tree, options)
      const proven = claudeChildCloseProven(result) || result.killDelivered === true
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
      startup.finish()
      return true
    })()
    return closePromise
  }

  advisory?.bindClose(close, handlers.onFault)

  const controls = createClaudeControlSurface(session)
  return {
    ...controls,
    startupFailure: startup.failure,
    exited: exited.promise,
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
        ...(tree.killDelivered || managed.lastCloseResult?.killDelivered
          ? { killDelivered: true as const }
          : {}),
        ...(managed.processless ? { processless: true } : {})
      } as const
    },
    pauseReading,
    resumeReading,
    send,
    close
  }
}
