import { withStructuredHistoryInvocation } from '../../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-invocation'
import { retryAcpRequest } from '../../protocol/acp-request-retry'
import { observeAcpForkSupport } from '../../capabilities/acp-fork-support'
import { withAcpStartupDiagnostic } from './acp-startup-diagnostic'
// An ACP child's handshake, run after the host has published it: initialize, reopen the chat's
// session or start a new one, then return its protocol facts to the host. A saved session the agent
// moved to another folder is reopened there; one it cannot reopen is replaced by a new one, with a
// warning row that any later start writes if this one never did; while a reopened session replays
// its history, nothing it sends is written except context usage, and afterwards the turns of it the
// chat never saw are added once.

import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { StructuredAgentSessionAcquireInput } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { StructuredAgentSessionProviderOpenResult } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import {
  ACP_REOPEN_FAILED,
  acpListedSessionFolder,
  acpReopenTakeover,
  acpSessionOtherFolder,
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
import { acpSessionStartMeta } from '../../launch/acp-session-meta'
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
  signal: AbortSignal
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
  if (launch.sessionMeta && launch.takesSessionMeta && !launch.takesSessionMeta(initialized)) {
    const version = initialized.agentInfo?.version
    throw new Error(
      `${agentName}${version ? ` ${version}` : ''} cannot take this chat's standing instructions, so it did not start`
    )
  }
  options.adoptInitialize(initialized)
  const meta = await spec.resolveSessionMeta?.({
    initialized,
    cwd: launch.cwd,
    env: launch.env,
    signal: input.signal
  })
  assertStarting()
  // Choose authentication using the execution host's launch environment.
  const authMethodId = spec.authMethod?.({
    advertised: (initialized.authMethods ?? []).map((method) => method.id),
    env: launch.env,
    antigravityChatAuth: launch.antigravityChatAuth
  })
  const setup = {
    ...acpSessionStartMeta(spec, meta),
    authMethodId,
    authMethodUnavailableMessage: spec.authMethodUnavailableMessage,
    resumePreference: spec.resumePreference
  }
  const resume = launch.resume
  let started: Awaited<ReturnType<AcpStructuredConnection['start']>> | null = null
  let liveLane: AcpStructuredLane | null = null
  let takeover: Awaited<ReturnType<typeof acpReopenTakeover>> | null = null
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
    const reopenIn = (cwd: string) =>
      retryAcpRequest(
        async () => {
          liveLane?.dispose()
          input.lanes.clear()
          const attaching = input.lanes.create(resume.sessionId, true)
          liveLane = attaching
          const opened = await connection.start(
            {
              cwd,
              mcpServers: launch.mcpServers ?? [],
              sessionId: resume.sessionId,
              ...(launch.sessionMeta && launch.sessionMetaOnReopen
                ? { _meta: launch.sessionMeta }
                : {}),
              ...setup
            },
            acceptSession
          )
          assertStarting()
          const frames = input.lanes.finishLoad()
          attaching.translator.finishLoad()
          return { opened, frames, lane: attaching }
        },
        { signal: input.signal, assertCurrent: assertStarting }
      )
    // A failed lookup fails the start; it says nothing about whether the session can reopen.
    const listedIn = spec.dialect.reopenMovesSession
      ? await retryAcpRequest(
          () =>
            acpListedSessionFolder(resume.sessionId, { initialized, connection, assertStarting }),
          { signal: input.signal, assertCurrent: assertStarting }
        )
      : null
    try {
      ;({
        opened: started,
        frames: replayed,
        lane: liveLane
      } = await reopenIn(listedIn ?? launch.cwd))
    } catch (refused) {
      let error: unknown = refused
      try {
        const movedTo = await retryAcpRequest(
          () =>
            acpSessionOtherFolder(refused, resume.sessionId, launch.cwd, {
              dialect: spec.dialect,
              initialized,
              connection,
              assertStarting
            }),
          { signal: input.signal, assertCurrent: assertStarting }
        )
        if (movedTo) {
          ;({ opened: started, frames: replayed, lane: liveLane } = await reopenIn(movedTo))
        }
      } catch (followFailed) {
        // A failed lookup or reopen gets the same takeover policy as the first refusal.
        error = followFailed
      }
      if (!started) {
        withAcpStartupDiagnostic(error, connection, spec.dialect)
        takeover = await acpReopenTakeover(error, resume, {
          // An agent already exited, its output still draining, has no session to take over in.
          over: connection.closed || connection.exited || input.abandoned(),
          now: now(),
          warn: (fields) => deps.logger?.warn(ACP_REOPEN_FAILED, { ...fields, sessionId })
        })
      }
    }
  }
  if (!started || !liveLane) {
    liveLane?.dispose()
    input.lanes.clear()
    const undo = await launch.aroundNewSession?.(launch.cwd)
    try {
      started = await connection.start(
        {
          cwd: launch.cwd,
          mcpServers: launch.mcpServers ?? [],
          ...(launch.sessionMeta ? { _meta: launch.sessionMeta } : {}),
          ...setup
        },
        acceptSession
      )
    } finally {
      await undo?.()
    }
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
    const identity = spec.historyCatchUp
    const sink = acquire.events
    await withStructuredHistoryInvocation(child, input.signal, (signal) =>
      catchUpAcpHistory({
        signal,
        frames: replayed,
        identity,
        sink,
        sessionId,
        agent: spec.agent,
        providerSessionId: started.sessionId,
        dialect: spec.dialect,
        assertCurrent: assertStarting,
        ...(deps.logger ? { logger: deps.logger } : {})
      })
    )
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
    ...(launch.resume?.lossKeys ?? []),
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
      compactCommand: spec.dialect.compactCommand,
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
