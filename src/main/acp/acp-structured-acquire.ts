// Publish and track the child before handshaking so startup cancellation can reach it.

import { initializeAcpStructuredSession } from './acp-structured-handshake'
import {
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import { providerSpawnedProcessIdentity } from '../provider-process/provider-spawned-process-identity'
import { acpPrivateTempConnect } from './acp-private-temp'
import {
  assertAcpStartingSession,
  isAcpReadySession,
  type AcpStructuredChild
} from './acp-structured-child'
import type { AcpSessionEvent } from './acp-session-runtime'
import type { AcpStructuredConnection } from './acp-structured-connection'
import { acpAgentName } from './acp-structured-agent-definitions'
import { AcpStructuredLane, acpLaneChildWorkDelivery } from './acp-structured-lane'
import { NO_ACP_CHILD_STOPS } from './acp-structured-child-stop'
import { prepareAcpStructuredLaunch } from './acp-structured-launch-preparation'
import { AcpStructuredOptions } from './acp-structured-options'
import { AcpStructuredPrompts } from './acp-structured-prompts'
import { AcpLoadHistory } from './acp-history-replay'
import { asReattachHistory, routeAcpSessionEvent } from './acp-structured-session'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { AcpStructuredTurnsDeps } from './acp-structured-turns'
import { RequestPermissionResponseSchema } from './generated/acp-protocol.generated'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const MAX_EARLY_FRAMES = 2_048

export async function acquireAcpStructuredSession(input: {
  acquire: StructuredAgentSessionAcquireInput
  deps: AcpStructuredSessionAdapterDeps
  generation: string
  /** Checked until spawn; afterward `track` gives cancellation the connection. */
  abandoned: () => boolean
  track: (connection: AcpStructuredConnection) => void
  onExit: (session: AcpStructuredChild | null) => void
  /** Protocol loss may precede process exit; null means startup has not produced a session. */
  onConnectionLost: (session: AcpStructuredChild | null, error: Error) => void
  onSettled: AcpStructuredTurnsDeps['settle']
  forceClose: (sessionId: string) => void
}): Promise<{
  acquisition: AgentSessionAcquisition
  session: AcpStructuredChild
}> {
  const { acquire, deps, generation } = input
  const { spec } = deps
  const agentName = acpAgentName(spec.agent)
  const logger = deps.logger ?? createStructuredAgentSessionLogger()
  const sessionId = acquire.identity.sessionId
  const now = deps.now ?? Date.now
  const events = acquire.events
  const sink = events ? providerTimelineSink(events) : null
  if (!sink) {
    throw new AgentSessionPreSpawnError(new Error(`${spec.agent} chats need a journal sink`))
  }
  const closedBeforeSpawn = () => {
    if (input.abandoned()) {
      throw new AgentSessionPreSpawnError(new Error(`${agentName} was closed before it started`))
    }
  }
  closedBeforeSpawn()
  const launch = await prepareAcpStructuredLaunch(deps, acquire, closedBeforeSpawn)
  let session: AcpStructuredChild | null = null
  // Use a slot so closure writes do not conflict with control-flow narrowing.
  const slot: {
    lane: AcpStructuredLane | null
    reattaching: boolean
    history: AcpLoadHistory | null
  } = { lane: null, reattaching: false, history: null }
  const options = new AcpStructuredOptions(launch.spec.dialect)
  // Agent-initiated turns cannot open interactive requests; settled request content may still show.
  const prompts = new AcpStructuredPrompts(
    () => slot.lane,
    () => isAcpReadySession(session) && session.turns?.acceptsRequests === true,
    () =>
      isAcpReadySession(session) &&
      (session.turns.acceptsRequests ||
        (!session.turns.running && !session.turns.stopped && session.lane.openTurnId !== null))
  )
  const early: (() => void)[] = []
  const whenLane = (deliver: () => void): void => {
    if (slot.lane) {
      deliver()
    } else if (early.length < MAX_EARLY_FRAMES) {
      early.push(deliver)
    }
  }
  // Keep the last abort check and spawn synchronous when no temp directory is needed.
  const connect = spec.privateTempDirectory
    ? await acpPrivateTempConnect(deps, closedBeforeSpawn)
    : deps.connect
  const connection = connect(
    {
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      envToDelete: launch.envToDelete
    },
    {
      clientInfo: { name: 'orca', version: '1' },
      ...(spec.signIn ? { signIn: spec.signIn } : {}),
      onPermission: (request, context) => {
        if (!isAcpReadySession(session) || !session.turns?.acceptsRequests) {
          // No interactive prompt remains during Stop, steering or an agent-initiated turn.
          return { outcome: { outcome: 'cancelled' } }
        }
        // Do not auto-approve questions or permissions enforced by the agent's own mode.
        const claimed = spec.dialect.request?.('session/request_permission', request)
        if (launch.fullAccess && !spec.permissionModeConfig && !claimed) {
          const allow = request.options.find((option) => option.kind === 'allow_once')
          if (allow) {
            return { outcome: { outcome: 'selected', optionId: allow.optionId } }
          }
        }
        return prompts
          .handle('session/request_permission', request, context)
          .then((reply) => RequestPermissionResponseSchema.parse(reply))
      },
      onRequest: (method, params, context) => prompts.handle(method, params, context),
      onExtensionNotification: (method, params) =>
        whenLane(() => {
          if (slot.reattaching) {
            slot.history?.keep(method, params)
          }
          slot.lane?.apply(
            slot.lane.translator.notification(
              method,
              slot.reattaching ? asReattachHistory(params) : params,
              now()
            )
          )
        }),
      onDiagnostic: (message) =>
        deps.logger?.warn('ACP agent protocol diagnostic', {
          scope: 'acp-diagnostic',
          sessionId,
          message
        }),
      // Protocol loss may leave the process alive; stdout EOF alone does not trigger this.
      onClose: (error) => input.onConnectionLost(session, error),
      // Read final diagnostics at process exit, which may follow stdout EOF.
      onExit: () => input.onExit(session)
    }
  )
  if (!spec.permissionModeConfig) {
    options.applied.set('permissionMode', launch.fullAccess ? 'full-access' : 'ask')
  }
  // From here, cancellation closes this connection even before exit is proven.
  input.track(connection)
  connection.subscribe((event: AcpSessionEvent) =>
    whenLane(() => {
      if (slot.lane) {
        if (slot.reattaching) {
          slot.history?.keep(
            'session/update',
            event.kind === 'known' ? event.notification : event.raw
          )
        }
        routeAcpSessionEvent({ lane: slot.lane, options }, event, now(), slot.reattaching)
      }
      if (
        isAcpReadySession(session) &&
        !session.ended &&
        event.kind === 'known' &&
        event.notification.update.sessionUpdate === 'config_option_update'
      ) {
        deps.onEvent?.({
          type: 'options-reported',
          sessionId,
          fence: acquire.fence,
          acquisitionGeneration: generation,
          reportedOptions: options.observedCurrent(spec.permissionModeConfig?.values)
        })
      }
    })
  )
  const identity = providerSpawnedProcessIdentity(
    acquire,
    `${spec.agent} ACP agent`,
    deps.readProcessStartTime
  )
  // Begin the attach window before replaying queued frames.
  const makeLane = (providerSessionId: string, attaching = false): AcpStructuredLane => {
    const lane = new AcpStructuredLane({
      sink,
      sessionId,
      agent: spec.agent,
      agentName,
      generation,
      providerSessionId,
      dialect: spec.dialect,
      now,
      childStops: () => session?.childStops ?? NO_ACP_CHILD_STOPS,
      ...acpLaneChildWorkDelivery(deps, sessionId, events),
      logger,
      onInputAccepted: (clientMessageId) => {
        if (isAcpReadySession(session)) {
          session.turns?.accept(clientMessageId)
        }
      },
      onFailed: () => input.forceClose(sessionId)
    })
    slot.lane = lane
    slot.reattaching = attaching
    // What the agent replays is kept for catch-up, never written as it arrives.
    slot.history =
      attaching && spec.historyCatchUp
        ? new AcpLoadHistory(providerSessionId, () =>
            logger.warn(`${agentName} chat did not catch up on turns made outside it`, {
              scope: 'acp-history-catch-up',
              sessionId,
              reason: 'replay-too-large'
            })
          )
        : null
    if (attaching) {
      lane.translator.beginLoad()
    }
    for (const deliver of early.splice(0)) {
      deliver()
    }
    return lane
  }
  await connection.spawned
  const pid = connection.pid
  if (pid === undefined) {
    throw new AgentSessionPreSpawnError(
      new Error(connection.stderrTail() || `${launch.command} could not be started`)
    )
  }
  await identity.onSpawned(pid)
  const process = await identity.read(pid)
  const child: AcpStructuredChild = {
    events,
    sessionId,
    fence: acquire.fence,
    acquisitionGeneration: generation,
    spec,
    connection,
    lane: null,
    turns: null,
    options,
    prompts,
    childStops: undefined,
    closeRequested: false,
    journalClosed: null,
    ended: false,
    exitObservedAt: null,
    open: (signal) =>
      initializeAcpStructuredSession({
        acquire,
        deps,
        generation,
        launch,
        connection,
        options,
        prompts,
        child,
        abandoned: () => signal.aborted,
        lanes: {
          create: makeLane,
          clear: () => {
            slot.lane = null
            slot.history = null
          },
          finishLoad: () => {
            slot.reattaching = false
            const replayed = slot.history?.frames() ?? null
            slot.history = null
            return replayed
          }
        },
        onSettled: input.onSettled,
        onSessionLost: (error) => input.onConnectionLost(child, error)
      }),
    dispose: () => {
      slot.lane?.dispose()
      early.length = 0
    }
  }
  session = child
  assertAcpStartingSession(child, input.abandoned)
  return {
    acquisition: { process, acquisitionGeneration: generation },
    session: child
  }
}
