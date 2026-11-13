import { randomUUID } from 'node:crypto'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { agentSessionProviderHandleKey } from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import { traexPermissionSettings } from './traex-launch-resolution'
import { readTraexModelCatalog } from './traex-model-catalog'
import { traexRecord, traexThreadResponseSchema, TraexRequestError } from './traex-protocol'
import { catchUpTraexHistory, readTraexTurns } from './traex-thread-history'
import { restoreTraexChildWork } from './traex-child-history'
import type { TraexSession } from './traex-session'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { reportedTraexPermissionMode } from './traex-permission-mode'
import { readTraexThreadGoal } from './traex-thread-goal'
import { refreshTraexBackgroundTerminals } from './traex-background-task-stops'

export async function openTraexSession(
  session: TraexSession,
  signal: AbortSignal,
  logger?: StructuredAgentSessionLogger
): Promise<StructuredAgentSessionProviderOpenResult> {
  const check = () => {
    signal.throwIfAborted()
    if (session.connection.closed) {
      throw session.failure ?? new Error('TRAE CLI exited while starting')
    }
  }
  const run = <T>(work: Promise<T>) => waitForPromiseWithSignal(work, signal)
  check()
  await run(session.connection.initialize())
  check()
  const config = Object.fromEntries(
    Object.entries(session.launch.commandEnv ?? {}).map(([key, value]) => [
      `shell_environment_policy.set.${key}`,
      value
    ])
  )
  const settings = {
    cwd: session.launch.cwd,
    ...traexPermissionSettings(session.launch.permissionMode),
    ...(Object.keys(config).length ? { config } : {})
  }
  let response: unknown
  let supersedesKey: string | undefined
  if (session.launch.previousThreadId) {
    try {
      response = await run(
        session.connection.request('thread/resume', {
          ...settings,
          threadId: session.launch.previousThreadId,
          excludeTurns: true
        })
      )
    } catch (error) {
      if (
        error instanceof TraexRequestError &&
        /already has an active writer/.test(error.message)
      ) {
        throw new AgentSessionAcquisitionRefusal(error.message, 'conversationOpenElsewhere')
      }
      if (
        !(error instanceof TraexRequestError) ||
        !session.launch.mayBeUnsaved ||
        !error.message.endsWith(`no rollout found for thread id ${session.launch.previousThreadId}`)
      ) {
        throw error
      }
      supersedesKey = agentSessionProviderHandleKey({
        transport: 'traex-app-server',
        agent: 'trae',
        nativeId: session.launch.previousThreadId
      })
    }
  }
  check()
  if (response === undefined) {
    response = await run(
      session.connection.request('thread/start', {
        ...settings,
        ...(session.options.model ? { model: session.options.model } : {})
      })
    )
  }
  const opened = traexThreadResponseSchema.parse(response)
  session.historyMode = opened.thread.historyMode ?? null
  session.reportedPermissionMode = reportedTraexPermissionMode(response)
  if (
    session.launch.permissionMode !== 'own' &&
    session.reportedPermissionMode !== session.launch.permissionMode
  ) {
    throw new AgentSessionAcquisitionRefusal(
      'TRAE CLI did not confirm the requested permission mode'
    )
  }
  if (
    session.launch.previousThreadId &&
    !supersedesKey &&
    opened.thread.id !== session.launch.previousThreadId
  ) {
    throw new Error('TRAE CLI resumed a different thread')
  }
  check()
  session.threadId = opened.thread.id
  if (opened.model) {
    session.options.model = opened.model
  }
  if (opened.reasoningEffort) {
    session.options.effort = opened.reasoningEffort
  }
  const sink = session.input.events
  if (!sink) {
    throw new Error('TRAE CLI chats require a journal sink')
  }
  session.bindThread(session.threadId)
  if (session.launch.previousThreadId && !supersedesKey) {
    const turns = await run(readTraexTurns(session.connection, session.threadId, check))
    await run(
      catchUpTraexHistory({
        connection: session.connection,
        threadId: session.threadId,
        sessionId: session.input.identity.sessionId,
        sink,
        signal,
        logger,
        turns
      })
    )
    await run(restoreTraexChildWork(session, turns, signal))
  }
  check()
  session.finishStartup()
  const modes = traexRecord(
    await run(session.connection.request('collaborationMode/list')).catch(() => null)
  )
  const modeEntries = Array.isArray(modes.data) ? modes.data : []
  session.interactionModeSupported = ['default', 'plan'].every((mode) =>
    modeEntries.some((entry) => traexRecord(entry).mode === mode)
  )
  if (session.interactionModeSupported && !session.options.interactionMode) {
    session.options.interactionMode = 'default'
  }
  await run(
    Promise.all([
      session
        .refreshCommands()
        .catch((error: unknown) =>
          logger?.warn('TRAE CLI skill catalog unavailable', { scope: 'traex-skills', error })
        ),
      readTraexThreadGoal(session),
      refreshTraexBackgroundTerminals(session, session.threadId),
      session.connection
        .request('thread/contextUsage', { threadId: session.threadId })
        .then((value) => session.timeline?.observeContext(value))
        .catch(() => {})
    ])
  )
  const catalog = await run(readTraexModelCatalog(session.connection).catch(() => null))
  check()
  if (catalog) {
    session.nativeModels = catalog.native
    session.models = catalog.models
    const current = catalog.native.find(
      (model) => model.id === session.options.model || model.model === session.options.model
    )
    if (current) {
      session.options.model = current.id
    }
  }
  return {
    link: {
      linkId: randomUUID(),
      handle: { transport: 'traex-app-server', agent: 'trae', nativeId: session.threadId },
      origin: session.launch.previousThreadId && !supersedesKey ? 'resumed' : 'created',
      mintedAtFence: session.input.fence,
      observedAt: Date.now(),
      ...(supersedesKey ? { supersedesKey } : {})
    },
    reportedOptions: session.readOptions().current,
    ...(catalog ? { catalogListing: { models: catalog.models } } : {})
  }
}
