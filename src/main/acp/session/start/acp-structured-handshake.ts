import { observeAcpForkSupport } from '../../capabilities/acp-fork-support'
// An ACP child's handshake, run after the host has published it: initialize, reopen the chat's
// session or start a new one, then return its protocol facts to the host. A saved session the
// agent cannot reopen is replaced by a new one, with a warning row that any later start writes if
// this one never did; while a reopened session replays its history, nothing it sends is written
// except context usage, and afterwards the turns of it the chat never saw are added once.

import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { StructuredAgentSessionAcquireInput } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenResult } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import {
  ACP_REOPEN_FAILED,
  acpReopenTakeover,
  acpSessionNotRestoredRow
} from './acp-session-reopen-failure'
import { catchUpAcpHistory } from '../../history/acp-history-catch-up'
import type { AcpLoadHistoryFrame } from '../../history/acp-history-replay'
import { ACP_HANDLE_TRANSPORT, acpAgentName } from '../acp-structured-agent-definitions'
import { probeAcpChildStops } from '../../turns/acp-structured-child-stop'
import type { AcpStructuredConnection } from '../../process/acp-structured-connection'
import type { AcpStructuredLane } from '../../journal/acp-structured-lane'
import type { AcpStructuredLaunch } from '../../launch/acp-structured-launch-resolution'
import type { AcpStructuredOptions } from '../../options/acp-structured-options'
import type { AcpStructuredPrompts } from '../../requests/acp-structured-prompts'
import type { AcpStructuredSessionAdapterDeps } from '../acp-structured-session-adapter-deps'
import { AcpStructuredTurns } from '../../turns/acp-structured-turns'
import type { AcpStructuredTurnsDeps } from '../../turns/acp-turn-dispatch-contract'
import { acpNoModelSelected } from '../../turns/acp-model-command'
import {
  assertAcpStartingSession,
  isAcpReadySession,
  type AcpStructuredChild
} from '../children/acp-structured-child'

type AcpHandshakeInput = {
  acquire: StructuredAgentSessionAcquireInput
  deps: AcpStructuredSessionAdapterDeps
  generation: string
  launch: AcpStructuredLaunch
  connection: AcpStructuredConnection
  options: AcpStructuredOptions
  prompts: AcpStructuredPrompts
  child: AcpStructuredChild
  abandoned: () => boolean
  lanes: {
    create: (providerSessionId: string, attaching?: boolean) => AcpStructuredLane
    clear: () => void
    /** The attach window is over: what the agent replayed in it, when it was kept. */
    finishLoad: () => AcpLoadHistoryFrame[] | null
  }
  onSettled: AcpStructuredTurnsDeps['settle']
  onSessionLost: AcpStructuredTurnsDeps['sessionLost']
}

export async function initializeAcpStructuredSession(
  input: AcpHandshakeInput
): Promise<StructuredAgentSessionProviderOpenResult> {
  const { acquire, deps, launch, connection, options, prompts, child, onSettled } = input
  const { spec } = launch
  const sessionId = acquire.identity.sessionId
  const now = deps.now ?? Date.now
  const assertStarting = () => assertAcpStartingSession(child, input.abandoned)
  const agentName = acpAgentName(spec.agent)
  assertStarting()
  const initialized = await connection.initialize()
  assertStarting()
  observeAcpForkSupport(spec.agent, initialized)
  options.adoptInitialize(initialized)
  // Choose authentication using the execution host's launch environment.
  const authMethodId = spec.authMethod?.({
    advertised: (initialized.authMethods ?? []).map((method) => method.id),
    env: launch.env,
    antigravityChatAuth: launch.antigravityChatAuth
  })
  const setup = {
    authMethodId,
    authMethodUnavailableMessage: spec.authMethodUnavailableMessage,
    resumePreference: spec.resumePreference
  }
  const resume = launch.resume
  let started: Awaited<ReturnType<AcpStructuredConnection['start']>> | null = null
  let liveLane: AcpStructuredLane | null = null
  let takeover: ReturnType<typeof acpReopenTakeover> | null = null
  let replayed: AcpLoadHistoryFrame[] | null = null
  const acceptSession = (accepted: NonNullable<typeof started>): void => {
    assertStarting()
    if (accepted.kind === 'new') {
      liveLane = input.lanes.create(accepted.sessionId)
      assertStarting()
    }
    options.adoptSession(accepted.response, accepted.kind === 'new' ? 'new' : 'loaded')
  }
  if (resume) {
    const attaching = input.lanes.create(resume.sessionId, true)
    liveLane = attaching
    try {
      started = await connection.start(
        {
          cwd: launch.cwd,
          mcpServers: [],
          sessionId: resume.sessionId,
          ...setup
        },
        acceptSession
      )
      assertStarting()
      replayed = input.lanes.finishLoad()
      attaching.translator.finishLoad()
    } catch (error) {
      takeover = acpReopenTakeover(error, resume, {
        // An agent already exited, its output still draining, has no session to take over in.
        over: connection.closed || connection.exited || input.abandoned(),
        now: now(),
        warn: (fields) => deps.logger?.warn(ACP_REOPEN_FAILED, { ...fields, sessionId })
      })
    }
  }
  if (!started || !liveLane) {
    liveLane?.dispose()
    input.lanes.clear()
    started = await connection.start({ cwd: launch.cwd, mcpServers: [], ...setup }, acceptSession)
    assertStarting()
  }
  if (!liveLane) {
    throw new Error('ACP session did not open')
  }
  // Only a load that reopened the chat's own conversation catches up, and only from what that
  // conversation replayed; a replacement session has no history of the chat's to add.
  if (
    replayed &&
    spec.historyCatchUp &&
    !takeover &&
    started.kind !== 'new' &&
    started.sessionId === resume?.sessionId &&
    acquire.events
  ) {
    await catchUpAcpHistory({
      frames: replayed,
      identity: spec.historyCatchUp,
      sink: acquire.events,
      sessionId,
      agent: spec.agent,
      providerSessionId: started.sessionId,
      dialect: spec.dialect,
      assertCurrent: assertStarting,
      ...(deps.logger ? { logger: deps.logger } : {})
    })
    assertStarting()
  }
  const childStops = await probeAcpChildStops(connection, spec.dialect, initialized)
  assertStarting()
  liveLane.apply(liveLane.translator.contextModels(started.response.models, now()))
  const mode = spec.permissionModeConfig
  if (mode && acquire.permissionMode !== 'own') {
    // Fail startup rather than silently use a different permission mode.
    const wanted = acquire.permissionMode ?? 'ask'
    const requested = child.permissionModes?.[wanted]
    if (requested === undefined) {
      throw new Error(`${agentName} on this host cannot run in the ${wanted} permission mode`)
    }
    const configId = options.modeConfigId()
    await connection.setConfigOption(configId, requested, undefined, ({ configOptions }) => {
      assertStarting()
      if (configOptions.find((option) => option.id === configId)?.currentValue !== requested) {
        throw new Error('Permission mode could not be confirmed')
      }
      options.adoptConfigOptions(configOptions)
    })
    assertStarting()
  }
  // A load restores the conversation's own model, so only a new session runs the launch choice.
  if (started.kind === 'new' && launch.launchModel) {
    options.adoptLaunchModel(launch.launchModel)
  }
  const link: AgentSessionProviderHandleLink = {
    linkId:
      deps.mintLinkId?.() ?? `${spec.agent}-${acquire.fence}-${started.sessionId}`.slice(0, 128),
    handle: { transport: ACP_HANDLE_TRANSPORT, agent: spec.agent, nativeId: started.sessionId },
    origin: started.kind === 'new' ? 'created' : 'resumed',
    mintedAtFence: acquire.fence,
    observedAt: now(),
    ...takeover
  }
  const reading = liveLane
  const unbind = acquire.events?.bindReadingControl?.({
    pauseReading: () => connection.pauseReading(),
    resumeReading: () => {
      connection.resumeReading()
      reading.retry()
    }
  })
  if (unbind) {
    child.unbindReadingControl = unbind
  }
  if (connection.exited || connection.closed) {
    throw new Error(connection.stderrTail() || `${spec.command} exited while starting`)
  }
  // Include warning rows missed by earlier failed starts.
  const lost = [
    ...(launch.resume?.unannouncedLosses() ?? []),
    ...(takeover?.replaces ? [takeover.replaces.key] : [])
  ]
  for (const key of lost) {
    liveLane.apply(acpSessionNotRestoredRow(key, started.sessionId, agentName))
  }
  assertStarting()
  Object.assign(child, {
    childStops,
    lane: liveLane,
    turns: new AcpStructuredTurns({
      connection,
      withdrawRequests: () => prompts.withdrawAll(),
      lane: liveLane,
      agentName,
      now,
      settle: onSettled,
      sessionLost: input.onSessionLost,
      modelRefusal: (error) => acpNoModelSelected(spec.dialect, options, error)
    })
  })
  if (!isAcpReadySession(child)) {
    throw new Error('ACP session did not open')
  }
  return {
    link,
    reportedOptions: options.observedCurrent(child.permissionModes),
    catalogListing: options.startListing()
  }
}
