// Publish and track the child before handshaking so startup cancellation can reach it.

import { initializeAcpStructuredSession } from './start/acp-structured-handshake'
import '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { providerTimelineSink } from '../../native-chat/agent-session-timeline/provider-timeline-plan'
import { providerSpawnedProcessIdentity } from '../../provider-process/provider-spawned-process-identity'
import { acpClientInfo } from '../launch/acp-client-info'
import * as childState from './children/acp-structured-child'
import type { AcpSessionEvent } from '../protocol/acp-session-events'
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import { keptAcpStartTime, launchRelayedAcpAgent } from '../process/acp-kept-agent'
import { keptAcpLaunchPermission } from '../process/acp-kept-launch-permission'
import { carryOnKeptAcpAgent } from './start/acp-kept-turn'
import { acpAgentName } from './acp-structured-agent-definitions'
import { AcpStructuredLane } from '../journal/acp-structured-lane'
import { acpLaneChildWorkDelivery } from '../journal/acp-lane-child-work-delivery'
import { NO_ACP_CHILD_STOPS } from '../turns/acp-structured-child-stop'
import {
  acpLaunchConnect,
  prepareAcpStructuredLaunch
} from '../launch/acp-structured-launch-preparation'
import { acpProcessEnvironment } from '../launch/acp-structured-launch-resolution'
import { SharedToolProcessSession } from '../../runtime/agent-session/environment/shared-tool-process-callers'
import { AcpStructuredOptions } from '../options/acp-structured-options'
import { AcpStructuredPrompts } from '../requests/acp-structured-prompts'
import { acpRunRequests, acpToolFreeRun, stopAtToolWork } from './acp-tool-free-run'
import { withAcpUrlElicitation } from '../requests/acp-url-elicitation'
import { AcpLoadHistory } from '../history/acp-history-replay'
import { asReattachHistory } from '../history/acp-reattach-history'
import { reportsAcpOptions, routeAcpSessionEvent } from '../timeline/acp-session-event-routing'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { AcpStructuredTurnsDeps } from '../turns/acp-turn-dispatch-contract'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'

const MAX_EARLY_FRAMES = 2_048

export async function acquireAcpStructuredSession(input: {
  acquire: StructuredAgentSessionAcquireInput
  deps: AcpStructuredSessionAdapterDeps
  generation: string
  /** Checked until spawn; afterward `track` gives cancellation the connection. */
  abandoned: () => boolean
  track: (connection: AcpStructuredConnection) => void
  onExit: (session: childState.AcpStructuredChild | null) => void
  /** Protocol loss may precede process exit; null means startup has not produced a session. */
  onConnectionLost: (session: childState.AcpStructuredChild | null, error: Error) => void
  onSettled: AcpStructuredTurnsDeps['settle']
  forceClose: (sessionId: string, reason: string) => void
  /** Like `forceClose`, and its running turn ends interrupted at once. */
  interrupt: (sessionId: string, reason: string) => void
}): Promise<{
  acquisition: AgentSessionAcquisition
  session: childState.AcpStructuredChild
}> {
  const { acquire, deps, generation } = input
  const agentName = acpAgentName(deps.spec.agent)
  const logger = deps.logger ?? createStructuredAgentSessionLogger()
  const sessionId = acquire.identity.sessionId
  const now = deps.now ?? Date.now
  const events = acquire.events
  const sink = events ? providerTimelineSink(events) : null
  if (!sink) {
    throw new AgentSessionPreSpawnError(new Error(`${deps.spec.agent} chats need a journal sink`))
  }
  const closedBeforeSpawn = () => {
    if (input.abandoned()) {
      throw new AgentSessionPreSpawnError(new Error(`${agentName} was closed before it started`))
    }
  }
  closedBeforeSpawn()
  const prepared = await prepareAcpStructuredLaunch(deps, input.acquire, closedBeforeSpawn)
  const { launch, acquire: run } = acpToolFreeRun(prepared, input.acquire)
  // The chat's account home pins its backend.
  const { spec } = launch
  let session: childState.AcpStructuredChild | null = null
  // Use a slot so closure writes do not conflict with control-flow narrowing.
  const slot: {
    lane: AcpStructuredLane | null
    reattaching: boolean
    history: AcpLoadHistory | null
  } = { lane: null, reattaching: false, history: null }
  const options = new AcpStructuredOptions(spec.dialect)
  const prompts = new AcpStructuredPrompts(
    () => slot.lane,
    () => childState.isAcpReadySession(session) && session.turns?.acceptsRequests === true
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
  const connect = await acpLaunchConnect(deps, launch, closedBeforeSpawn)
  let sharedTools: SharedToolProcessSession | null = null
  const { command, args, cwd } = launch
  const processLaunch = { command, args, cwd, ...acpProcessEnvironment(launch) }
  const relayed = await launchRelayedAcpAgent(input, launch, processLaunch)
  const launchPermission = await keptAcpLaunchPermission(spec, relayed, launch, run)
  // Cancellation owns no connection yet: the relayed agent goes as a tracked one would.
  if (relayed && input.abandoned()) {
    await relayed.managed.close().catch(() => undefined)
  }
  const fullAccess = launchPermission.permission === 'full-access'
  const connection = connect(processLaunch, {
    ...(relayed ? { relayed } : {}),
    clientInfo: acpClientInfo(spec),
    // Only a chat can show a URL request's card, so other connections never advertise it.
    clientCapabilities: withAcpUrlElicitation(spec.dialect.clientCapabilities),
    retryBusyPrompts: spec.agent === 'omp',
    ...(spec.signIn ? { signIn: spec.signIn } : {}),
    ...acpRunRequests(launch, () => session, prompts),
    onExtensionNotification: (method, params) =>
      whenLane(() => {
        relayed?.turns.observeSessionUpdate(params)
        if (slot.reattaching) {
          slot.history?.keep(method, params)
        }
        const sent = slot.reattaching ? asReattachHistory(params) : params
        slot.lane?.apply(slot.lane.translator.notification(method, sent, now()))
      }),
    onDiagnostic: (message) =>
      deps.logger?.warn('ACP agent protocol diagnostic', {
        scope: 'acp-diagnostic',
        sessionId,
        message
      }),
    // Protocol loss may leave the process alive; stdout EOF alone does not trigger this.
    onClose: (error) => {
      session?.historyCatchUp?.abort()
      input.onConnectionLost(session, error)
    },
    // Read final diagnostics at process exit, which may follow stdout EOF.
    onExit: () => {
      sharedTools?.end()
      session?.historyCatchUp?.abort()
      input.onExit(session)
    }
  })
  // Until the process exits, only its session's tools can name the chat.
  sharedTools = SharedToolProcessSession.forLaunch(spec, launch.env, launch.version)
  if (!spec.permissionModeConfig) {
    options.applied.set('permissionMode', fullAccess ? 'full-access' : 'ask')
  }
  // From here, cancellation closes this connection even before exit is proven.
  input.track(connection)
  stopAtToolWork(launch, connection, (reason) => input.interrupt(sessionId, reason))
  connection.subscribe((event: AcpSessionEvent) =>
    whenLane(() => {
      relayed?.turns.observeSessionUpdate(event.kind === 'known' ? event.notification : event.raw)
      if (slot.lane) {
        if (slot.reattaching) {
          slot.history?.keep(
            'session/update',
            event.kind === 'known' ? event.notification : event.raw
          )
        }
        routeAcpSessionEvent({ lane: slot.lane, options }, event, now(), slot.reattaching)
        if (
          event.kind === 'known' &&
          event.notification.update.sessionUpdate === 'available_commands_update'
        ) {
          events?.publish()
        }
      }
      if (
        childState.isAcpReadySession(session) &&
        !session.ended &&
        event.kind === 'known' &&
        reportsAcpOptions(event.notification.update)
      ) {
        deps.onEvent?.({
          type: 'options-reported',
          sessionId,
          fence: acquire.fence,
          acquisitionGeneration: generation,
          reportedOptions: options.observedCurrent(launchPermission.permissionModes),
          catalogListing: { models: options.read().models }
        })
      }
    })
  )
  const identity = providerSpawnedProcessIdentity(
    acquire,
    `${spec.agent} ACP agent`,
    keptAcpStartTime(relayed, deps.readProcessStartTime)
  )
  // Begin the attach window before replaying queued frames.
  // A kept agent replays no history: what it sends is live, even before its chat finished opening.
  const makeLane = (providerSessionId: string, reopening = false): AcpStructuredLane => {
    const attaching = reopening && !connection.kept
    const lane = new AcpStructuredLane({
      sink,
      sessionId,
      agent: spec.agent,
      agentName,
      generation,
      ...(relayed ? { requestGeneration: `relay:${relayed.child.relayId}` } : {}),
      onAgentTurnEnded: relayed?.turns.agentTurnEnded,
      providerSessionId,
      dialect: spec.dialect,
      now,
      childStops: () => session?.childStops ?? NO_ACP_CHILD_STOPS,
      ...acpLaneChildWorkDelivery(deps, sessionId, events),
      logger,
      onInputAccepted: (clientMessageId) => {
        if (childState.isAcpReadySession(session)) {
          session.turns?.accept(clientMessageId)
        }
      },
      onFailed: (reason) =>
        input.forceClose(
          sessionId,
          `Orca stopped ${agentName} after its chat journal refused a write (${reason})`
        )
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
  const child: childState.AcpStructuredChild = {
    events,
    sessionId,
    fence: acquire.fence,
    acquisitionGeneration: generation,
    spec,
    cwd: launch.cwd,
    ...launchPermission,
    connection,
    lane: null,
    turns: null,
    options,
    prompts,
    childStops: undefined,
    closeRequested: false,
    failureClose: null,
    journalClosed: null,
    ended: false,
    exitObservedAt: null,
    open: (signal) =>
      initializeAcpStructuredSession({
        acquire: run,
        signal,
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
      })
        // Before the first turn, so no tool of this session runs without its identity.
        .then((opened) => sharedTools?.publishFor(opened) ?? opened)
        .then((opened) => carryOnKeptAcpAgent(opened, child, deps, signal)),
    dispose: () => {
      child.historyCatchUp?.abort()
      slot.lane?.dispose()
      early.length = 0
    }
  }
  session = child
  childState.assertAcpStartingSession(child, input.abandoned)
  return {
    acquisition: {
      process,
      acquisitionGeneration: generation,
      // The chat keeps the home this launch moved it to.
      ...(launch.launchedAccountHome ? { movedAccountHome: launch.launchedAccountHome } : {})
    },
    session: child
  }
}
