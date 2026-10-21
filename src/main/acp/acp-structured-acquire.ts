// Making a reservation real for an ACP agent: open its connection (which spawns and owns the
// process) and record it before any handshake, so the host publishes the child at spawn. The
// handshake (`acp-structured-handshake`) runs after: initialize, then reattach the session this chat
// proved with `session/load` (`session/resume` for an agent that cannot load) or start a new one,
// and the host receives protocol facts once that session answers. The handshake has no time bound of
// its own: the host's startup limit, or a close, Stop or quit, stops it at any point.

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
import { asReattachHistory, routeAcpSessionEvent } from './acp-structured-session'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { AcpStructuredTurnsDeps } from './acp-structured-turns'
import { RequestPermissionResponseSchema } from './generated/acp-protocol.generated'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

/** Frames an agent may send before its session exists; past this they are dropped. */
const MAX_EARLY_FRAMES = 2_048

export async function acquireAcpStructuredSession(input: {
  acquire: StructuredAgentSessionAcquireInput
  deps: AcpStructuredSessionAdapterDeps
  generation: string
  /** The spawn was aborted; checked until the spawn, after which `track` hands it the connection. */
  abandoned: () => boolean
  /** Registers the connection so a close during the acquire can stop it. */
  track: (connection: AcpStructuredConnection) => void
  /** The process's exit, observed while or after the session exists. */
  onExit: (session: AcpStructuredChild | null) => void
  /** The protocol broke with the process perhaps still running. Null while starting: then the
   *  start itself fails. */
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
  // A slot rather than a `let`: closures read it, and control-flow narrowing cannot see them write.
  const slot: { lane: AcpStructuredLane | null; reattaching: boolean } = {
    lane: null,
    reattaching: false
  }
  const options = new AcpStructuredOptions(launch.spec.dialect)
  // Only Orca's own prompt may ask the person, as with permissions: a turn the agent began itself
  // has nobody waiting on it. What a settled request carries still shows in that turn.
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
  // No await for an agent without the flag: nothing may come between the last abort check and spawn.
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
          // No prompt of Orca's runs (a turn the agent began itself included), or a Stop or steer
          // is cutting it short: nobody is there to ask.
          return { outcome: { outcome: 'cancelled' } }
        }
        // Full access never answers a dialect's question, nor an agent that enforces the mode itself.
        const claimed = spec.dialect.request?.('session/request_permission', request)
        if (launch.fullAccess && !spec.permissionModeConfig && !claimed) {
          // Full access: Orca answers yes for the person, as the agent's own bypass flag would.
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
        whenLane(() =>
          slot.lane?.apply(
            slot.lane.translator.notification(
              method,
              slot.reattaching ? asReattachHistory(params) : params,
              now()
            )
          )
        ),
      onDiagnostic: (message) =>
        deps.logger?.warn('ACP agent protocol diagnostic', {
          scope: 'acp-diagnostic',
          sessionId,
          message
        }),
      // The protocol broke while the process may still run; the connection is already ending it.
      // Its stdout ending alone is not this: the agent may still answer Stop's cancel or exit.
      onClose: (error) => input.onConnectionLost(session, error),
      // A crash usually ends stdout first; the session's end still reads the agent's last words at
      // this proven exit.
      onExit: () => input.onExit(session)
    }
  )
  // From here an abort closes this connection (the start's one canceller): whatever the agent left
  // unanswered fails at once and the process ends, whether or not its exit is proven yet.
  input.track(connection)
  connection.subscribe((event: AcpSessionEvent) =>
    whenLane(() => {
      if (slot.lane) {
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
          reportedOptions: options.read().current
        })
      }
    })
  )
  const identity = providerSpawnedProcessIdentity(
    acquire,
    `${spec.agent} ACP agent`,
    deps.readProcessStartTime
  )
  /** `attaching`: the lane opens inside the attach window, before any frame queued so far. */
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
      logger: deps.logger ?? createStructuredAgentSessionLogger(),
      onInputAccepted: (clientMessageId) => {
        if (isAcpReadySession(session)) {
          session.turns?.accept(clientMessageId)
        }
      },
      onFailed: () => input.forceClose(sessionId)
    })
    slot.lane = lane
    slot.reattaching = attaching
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
          },
          finishLoad: () => {
            slot.reattaching = false
          }
        },
        onSettled: input.onSettled
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
