// Making a reservation real for an ACP agent: open its connection (which spawns and owns the
// process) and record it before any handshake, so the host publishes the child at spawn. The
// handshake (`acp-structured-handshake`) runs after: initialize, then reattach the session this chat
// proved with `session/load` (`session/resume` for an agent that cannot load) or start a new one,
// and the child reports `started` once that session answers. The handshake has no time bound of
// its own: the host's startup limit, or a close, Stop or quit, stops it at any point.

import { initializeAcpStructuredSession } from './acp-structured-handshake'
import {
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionStartedEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import {
  providerSpawnedProcessIdentity,
  PROVIDER_SPAWN_TOKEN_ENV
} from '../provider-process/provider-spawned-process-identity'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import {
  assertAcpStartingSession,
  type AcpStructuredChild,
  type AcpStartingSession
} from './acp-structured-child'
import { ACP_CHILD_ENV_TO_DELETE } from './acp-launch-specs'
import type { AcpSessionEvent } from './acp-session-runtime'
import type { AcpStructuredConnection } from './acp-structured-connection'
import { acpAgentName } from './acp-structured-agent-definitions'
import { AcpStructuredLane, acpLaneChildWorkDelivery } from './acp-structured-lane'
import { NO_ACP_CHILD_STOPS } from './acp-structured-child-stop'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { AcpStructuredOptions } from './acp-structured-options'
import { AcpStructuredPrompts } from './acp-structured-prompts'
import {
  asReattachHistory,
  routeAcpSessionEvent,
  type AcpStructuredSession
} from './acp-structured-session'
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
  /** The acquire was aborted; checked until the spawn, after which `track` hands it the connection. */
  abandoned: () => boolean
  /** Registers the connection so a close during the acquire can stop it. */
  track: (connection: AcpStructuredConnection) => void
  /** The process's exit, observed while or after the session exists. */
  onExit: (session: AcpStructuredChild | null) => void
  /** The protocol broke with the process perhaps still running. Null while starting: then the
   *  start itself fails. */
  onConnectionLost: (session: AcpStructuredChild | null, error: Error) => void
  onReady: (session: AcpStructuredSession, event: StructuredAgentSessionStartedEvent) => void
  onSettled: AcpStructuredTurnsDeps['settle']
  forceClose: (sessionId: string) => void
}): Promise<{
  acquisition: AgentSessionAcquisition
  session: AcpStartingSession
  initialize: () => Promise<void>
}> {
  const { acquire, deps, generation } = input
  const { spec } = deps
  const sessionId = acquire.identity.sessionId
  const now = deps.now ?? Date.now
  const events = acquire.events
  const sink = events ? providerTimelineSink(events) : null
  if (!sink) {
    throw new AgentSessionPreSpawnError(new Error(`${spec.agent} chats need a journal sink`))
  }
  const closedBeforeSpawn = () => {
    if (input.abandoned()) {
      throw new AgentSessionPreSpawnError(
        new Error(`${acpAgentName(spec.agent)} was closed before it started`)
      )
    }
  }
  closedBeforeSpawn()
  const launch: AcpStructuredLaunch = await deps
    .resolveLaunch({ identity: acquire.identity })
    .catch((error: unknown) => {
      throw new AgentSessionPreSpawnError(error)
    })
  closedBeforeSpawn()
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
    () => session?.phase === 'ready' && session.turns.acceptsRequests,
    () =>
      session?.phase === 'ready' &&
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
  const connection = deps.connect(
    {
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: {
        ...structuredSessionChildIdentityEnv(sessionId, launch.env),
        [PROVIDER_SPAWN_TOKEN_ENV]: acquire.spawnToken
      },
      envToDelete: [...ACP_CHILD_ENV_TO_DELETE, ...launch.envToDelete]
    },
    {
      clientInfo: { name: 'orca', version: '1' },
      ...(acquire.onOutput ? { onOutput: acquire.onOutput } : {}),
      onPermission: (request, context) => {
        if (session?.phase !== 'ready' || !session.turns.acceptsRequests) {
          // No prompt of Orca's runs (a turn the agent began itself included), or a Stop or steer
          // is cutting it short: nobody is there to ask.
          return { outcome: { outcome: 'cancelled' } }
        }
        if (launch.fullAccess) {
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
      const optionRevision = acquire.optionRevision?.() ?? 0
      if (slot.lane) {
        routeAcpSessionEvent({ lane: slot.lane, options }, event, now(), slot.reattaching)
      }
      if (
        session?.phase === 'ready' &&
        !session.ended &&
        event.kind === 'known' &&
        event.notification.update.sessionUpdate === 'config_option_update'
      ) {
        deps.onEvent?.({
          type: 'options-reported',
          sessionId,
          fence: acquire.fence,
          acquisitionGeneration: generation,
          reportedOptions: options.read().current,
          restoreSkippedOptions: [],
          optionRevision
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
      agentName: acpAgentName(spec.agent),
      generation,
      providerSessionId,
      dialect: spec.dialect,
      now,
      childStops: () =>
        (session?.phase === 'ready' ? session.childStops : undefined) ?? NO_ACP_CHILD_STOPS,
      ...acpLaneChildWorkDelivery(deps, sessionId),
      logger: deps.logger ?? createStructuredAgentSessionLogger(),
      onInputAccepted: (clientMessageId) => {
        if (session?.phase === 'ready') {
          session.turns.accept(clientMessageId)
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
  const starting: AcpStartingSession = {
    phase: 'starting',
    sessionId,
    fence: acquire.fence,
    acquisitionGeneration: generation,
    spec,
    connection,
    closeRequested: false,
    journalClosed: null,
    ended: false,
    exitObservedAt: null,
    startupAnswered: false,
    dispose: () => {
      slot.lane?.dispose()
      early.length = 0
    }
  }
  session = starting
  assertAcpStartingSession(starting, input.abandoned)
  const initialize = () =>
    initializeAcpStructuredSession({
      acquire,
      deps,
      generation,
      launch,
      connection,
      options,
      prompts,
      starting,
      abandoned: input.abandoned,
      lanes: {
        create: makeLane,
        clear: () => {
          slot.lane = null
        },
        finishLoad: () => {
          slot.reattaching = false
        }
      },
      onSettled: input.onSettled,
      onReady: (ready, event) => {
        session = ready
        input.onReady(ready, event)
      }
    })
  return {
    acquisition: { process, acquisitionGeneration: generation },
    session: starting,
    initialize
  }
}
