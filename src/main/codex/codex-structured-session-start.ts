import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { initializeCodexAppServerConnection } from './codex-app-server-handshake'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CodexBackgroundTaskTracker, codexChildWorkSink } from './codex-background-task-tracker'
import type { CodexSubagentExecutions } from './codex-subagent-executions'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import type { CodexJournalTranslator } from './codex-structured-journal-translation'
import { codexProviderHandleLink } from './codex-structured-owner-identity'
import { openCodexThread } from './codex-structured-thread-open'
import { withCodexVisualsThreadConfig } from './codex-structured-visuals'
import { closeCodexPublishedSession } from './codex-structured-session-close'
import {
  restoredCodexSessionOptions,
  reportedCodexSessionOptions
} from './codex-structured-session-options'
import { startBackgroundCodexCatalogRefresh } from './codex-structured-background-catalog'
import { codexAcquireCatalogAccess } from './codex-structured-acquire-catalog'
import { reportedCodexThreadOptions } from './codex-structured-service-tier'
import {
  assertCodexConnectionOpen,
  codexSessionLifecycle,
  type CodexAcquisitionRegistry,
  type CodexAcquisitionAttempt,
  type CodexSession,
  type CodexStructuredLaunch,
  type CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'
import type { CodexStructuredSessionTeardown } from './codex-structured-session-teardown'

type CodexStartInput = {
  input: StructuredAgentSessionAcquireInput
  deps: CodexStructuredSessionAdapterDeps
  launch: CodexStructuredLaunch
  account: AgentSessionAccountKind | undefined
  sessions: Map<string, CodexSession>
  acquisitions: CodexAcquisitionRegistry
  attempt: CodexAcquisitionAttempt
  connection: CodexAppServerConnection
  translator: CodexJournalTranslator | null
  dispatchEchoes: CodexDispatchEchoes
  subagentExecutions: CodexSubagentExecutions
  setPrimaryThreadId: (threadId: string) => void
  forceCloseUnexpected: CodexStructuredSessionTeardown['forceCloseUnexpected']
  unbindReadingControl?: () => void
}

/** Runs after acquisition publishes the child; optional discovery never holds readiness. */
export async function startCodexStructuredSession(start: CodexStartInput): Promise<void> {
  const { input, deps, launch, sessions, acquisitions, attempt, connection, translator } = start
  const sessionId = input.identity.sessionId
  const child = attempt.startingChild
  if (!child) {
    return
  }
  const current = (): void => {
    acquisitions.assertCurrent(sessionId, attempt)
    assertCodexConnectionOpen(connection, sessionId)
    if (child.ended) {
      throw new Error('codex child ended during startup')
    }
  }
  try {
    await initializeCodexAppServerConnection(connection)
    child.initializeAnswered = true
    current()
    const threadLaunch = await withCodexVisualsThreadConfig(connection, launch, {
      sessionId,
      ...(deps.logger ? { logger: deps.logger } : {})
    })
    current()
    const optionRevision = input.optionRevision?.() ?? 0
    const opened = await openCodexThread(connection, threadLaunch, deps.requestTimeoutMs)
    current()
    start.setPrimaryThreadId(opened.threadId)
    const restored = translator?.restoreThread(opened.threadId, opened.thread ?? {})
    if (restored && !restored.accepted) {
      throw AgentSessionAcquisitionRefusal.historyTooLarge(
        'Codex thread history exceeds the bounded restore queue; history was not partially imported.'
      )
    }
    const options = restoredCodexSessionOptions(input.options)
    const catalogAccess = codexAcquireCatalogAccess(deps, launch)
    const session: CodexSession = {
      account: start.account,
      connection,
      startingChild: child,
      ...codexSessionLifecycle(input.fence, child.acquisitionGeneration),
      threadId: opened.threadId,
      historyMode: opened.historyMode,
      activeTurnIds: new Set(),
      abortedTurnIds: new Set(),
      prompts: attempt.window.prompts,
      options,
      reportedOptions: reportedCodexThreadOptions(opened),
      ...(catalogAccess ? { catalogAccess } : {}),
      dispatchEchoes: start.dispatchEchoes,
      translator,
      backgroundTasks: new CodexBackgroundTaskTracker(
        opened.threadId,
        start.subagentExecutions,
        codexChildWorkSink(sessionId, deps)
      ),
      forceCloseUnexpected: (reason) =>
        start.forceCloseUnexpected(sessionId, input.fence, child.acquisitionGeneration, reason),
      ...(start.unbindReadingControl ? { unbindReadingControl: start.unbindReadingControl } : {})
    }
    current()
    sessions.set(sessionId, session)
    for (const event of attempt.window.drain()) {
      event()
    }
    current()
    deps.onEvent?.({
      type: 'started',
      sessionId,
      fence: input.fence,
      acquisitionGeneration: child.acquisitionGeneration,
      link: codexProviderHandleLink({
        threadId: opened.threadId,
        ...(opened.supersededThreadId
          ? { resumed: false, supersedesThreadId: opened.supersededThreadId }
          : { resumed: launch.resumeThreadId !== null }),
        fence: input.fence,
        linkId: deps.mintLinkId?.(),
        observedAt: deps.now?.() ?? Date.now()
      }),
      reportedOptions: reportedCodexSessionOptions(session),
      restoreSkippedOptions: [],
      optionRevision
    })
    delete session.startingChild
    acquisitions.deleteIfCurrent(sessionId, attempt)
    startBackgroundCodexCatalogRefresh({
      session,
      sessionId,
      sessions,
      timeoutMs: deps.requestTimeoutMs,
      logger: deps.logger
    })
  } catch (error) {
    if (child.ended || attempt.cancelled) {
      return
    }
    child.failure = error instanceof Error ? error : new Error(String(error))
    try {
      let exited: boolean
      if (sessions.get(sessionId)?.connection === connection) {
        exited = await closeCodexPublishedSession(sessions, sessionId, deps.onEvent, {
          requestedClose: false,
          unexpectedReason: child.failure,
          ...(deps.logger ? { logger: deps.logger } : {})
        })
      } else {
        exited = await connection.close()
        if (exited) {
          attempt.exitProven = true
          child.end(child.failure)
          acquisitions.deleteIfCurrent(sessionId, attempt)
        }
      }
      if (!exited) {
        throw new Error('codex startup cleanup could not prove child exit')
      }
      attempt.exitProven = true
      acquisitions.deleteIfCurrent(sessionId, attempt)
    } catch (cleanupError) {
      try {
        deps.logger?.warn('Codex startup cleanup could not prove exit', {
          scope: 'codex-startup',
          sessionId,
          error: cleanupError
        })
      } catch {
        // Reporting cannot reject startup's background task.
      }
    }
  }
}
