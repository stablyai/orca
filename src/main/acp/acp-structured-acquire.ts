// Making a reservation real for an ACP agent: open its connection (which spawns and owns the
// process), record it before any handshake, initialize with the client's file system and terminals
// off, then reattach the session this chat proved with `session/load` (`session/resume` only for an
// agent that cannot load) or start a new one. A saved session the agent cannot reopen is replaced
// by a new one, with a warning row that any later start writes if this attach never did. The
// journal already holds a reattached chat, so whatever the agent sends while it reattaches is not
// written, except context usage. The handshake has no time bound: the acquire's abort signal
// (Close, Stop, quit) stops it at any point.

import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import { isTuiAgent } from '../../shared/tui-agent-config'
import {
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import {
  providerSpawnedProcessIdentity,
  PROVIDER_SPAWN_TOKEN_ENV
} from '../provider-process/provider-spawned-process-identity'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import { AcpAgentError } from './acp-errors'
import { acpAuthenticationRequired, acpSignInRequiredRefusal } from './acp-turn-failures'
import { ACP_CHILD_ENV_TO_DELETE } from './acp-launch-specs'
import {
  ACP_REOPEN_FAILED,
  acpReopenTakeover,
  acpSessionNotRestoredRow
} from './acp-session-reopen-failure'
import type { AcpSessionEvent } from './acp-session-runtime'
import type { AcpStructuredConnection } from './acp-structured-connection'
import { ACP_HANDLE_TRANSPORT } from './acp-structured-agent-definitions'
import { AcpStructuredLane } from './acp-structured-lane'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { AcpStructuredOptions, restoreAcpSessionOptions } from './acp-structured-options'
import { AcpStructuredPrompts } from './acp-structured-prompts'
import {
  asReattachHistory,
  routeAcpSessionEvent,
  type AcpStructuredSession
} from './acp-structured-session'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import { AcpStructuredTurns, type AcpStructuredTurnsDeps } from './acp-structured-turns'
import { RequestPermissionResponseSchema } from './generated/acp-protocol.generated'

/** Frames an agent may send before its session exists; past this they are dropped. */
const MAX_EARLY_FRAMES = 2_048
export function acpAgentName(agent: string): string {
  return isTuiAgent(agent) ? TUI_AGENT_DISPLAY_NAMES[agent] : agent
}

export async function acquireAcpStructuredSession(input: {
  acquire: StructuredAgentSessionAcquireInput
  deps: AcpStructuredSessionAdapterDeps
  generation: string
  /** The acquire was aborted; checked until the spawn, after which `track` hands it the connection. */
  abandoned: () => boolean
  /** Registers the connection so a close during the acquire can stop it. */
  track: (connection: AcpStructuredConnection) => void
  /** The process's exit, observed while or after the session exists. */
  onExit: (session: AcpStructuredSession | null) => void
  /** The protocol broke with the process perhaps still running. Null while starting: then the
   *  start itself fails. */
  onConnectionLost: (session: AcpStructuredSession | null, error: Error) => void
  onSettled: AcpStructuredTurnsDeps['settle']
  forceClose: (sessionId: string) => void
}): Promise<{ acquisition: AgentSessionAcquisition; session: AcpStructuredSession }> {
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
  let session: AcpStructuredSession | null = null
  // A slot rather than a `let`: closures read it, and control-flow narrowing cannot see them write.
  const slot: { lane: AcpStructuredLane | null; reattaching: boolean } = {
    lane: null,
    reattaching: false
  }
  const options = new AcpStructuredOptions()
  // Only Orca's own prompt may ask the person, as with permissions: a turn the agent began itself
  // has nobody waiting on it. What a settled request carries still shows in that turn.
  const prompts = new AcpStructuredPrompts(
    () => slot.lane,
    () => session?.turns.acceptsRequests === true,
    () =>
      session !== null &&
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
        if (!session?.turns.acceptsRequests) {
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
    whenLane(
      () =>
        slot.lane &&
        routeAcpSessionEvent({ lane: slot.lane, options }, event, now(), slot.reattaching)
    )
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
      onInputAccepted: (clientMessageId) => session?.turns.accept(clientMessageId),
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
  const agentName = acpAgentName(spec.agent)
  try {
    const initialized = await connection.initialize()
    // Chosen here, on the machine Grok runs on, from the environment it was launched with.
    const authMethodId = spec.authMethod?.({
      advertised: (initialized.authMethods ?? []).map((method) => method.id),
      env: launch.env
    })
    const auth = authMethodId === undefined ? {} : { authMethodId }
    const resume = launch.resume
    let started: Awaited<ReturnType<AcpStructuredConnection['start']>> | null = null
    let liveLane: AcpStructuredLane | null = null
    let takeover: ReturnType<typeof acpReopenTakeover> | null = null
    if (resume) {
      const attaching = makeLane(resume.sessionId, true)
      liveLane = attaching
      try {
        started = await connection.start({
          cwd: launch.cwd,
          mcpServers: [],
          sessionId: resume.sessionId,
          ...auth
        })
        slot.reattaching = false
        attaching.translator.finishLoad()
      } catch (error) {
        takeover = acpReopenTakeover(error, resume, {
          over: connection.closed || acquire.signal?.aborted === true,
          now: now(),
          warn: (fields) => deps.logger?.warn(ACP_REOPEN_FAILED, { ...fields, sessionId })
        })
        // A new session takes the old one's place, with a new lane, so nothing of the failed
        // attach's window outlives it.
      }
    }
    if (!started || !liveLane) {
      liveLane?.dispose()
      slot.lane = null
      started = await connection.start({ cwd: launch.cwd, mcpServers: [], ...auth })
      liveLane = makeLane(started.sessionId)
    }
    options.adoptSession(started.response)
    liveLane.apply(liveLane.translator.contextModels(started.response.models, now()))
    const restoreSkipped = await restoreAcpSessionOptions(connection, options, acquire.options)
    const process = await identity.read(pid)
    const link: AgentSessionProviderHandleLink = {
      linkId:
        deps.mintLinkId?.() ?? `${spec.agent}-${acquire.fence}-${started.sessionId}`.slice(0, 128),
      handle: { transport: ACP_HANDLE_TRANSPORT, agent: spec.agent, nativeId: started.sessionId },
      origin: started.kind === 'new' ? 'created' : 'resumed',
      mintedAtFence: acquire.fence,
      observedAt: now(),
      ...takeover
    }
    session = {
      sessionId,
      fence: acquire.fence,
      acquisitionGeneration: generation,
      spec,
      connection,
      lane: liveLane,
      prompts,
      options,
      turns: new AcpStructuredTurns({
        connection,
        withdrawRequests: () => prompts.withdrawAll(),
        lane: liveLane,
        agentName,
        now,
        settle: input.onSettled
      }),
      restoreSkipped,
      closeRequested: false,
      journalClosed: null,
      ended: false,
      exitObservedAt: null
    }
    const reading = liveLane
    const unbind = events?.bindReadingControl?.({
      pauseReading: () => connection.pauseReading(),
      resumeReading: () => {
        connection.resumeReading()
        reading.retry()
      }
    })
    if (unbind) {
      session.unbindReadingControl = unbind
    }
    if (connection.exited || connection.closed) {
      throw new Error(connection.stderrTail() || `${spec.command} exited while starting`)
    }
    // The chat says once per lost conversation that the agent forgot it, this start's loss included.
    const lost = [
      ...(launch.resume?.unannouncedLosses() ?? []),
      ...(takeover?.replaces ? [takeover.replaces.key] : [])
    ]
    for (const key of lost) {
      liveLane.apply(acpSessionNotRestoredRow(key, started.sessionId, agentName))
    }
    return { acquisition: { process, link, acquisitionGeneration: generation }, session }
  } catch (error) {
    session = null
    slot.lane?.dispose()
    if (error instanceof AcpAgentError && acpAuthenticationRequired(spec.dialect, error)) {
      throw acpSignInRequiredRefusal(spec.agent, spec.dialect, error)
    }
    throw error
  }
}
