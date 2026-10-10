// An ACP child's handshake, run after the host has published it: initialize, reopen the chat's
// session or start a new one, restore its saved options, then report `started`. A saved session the
// agent cannot reopen is replaced by a new one, with a warning row that any later start writes if
// this one never did; while a reopened session replays history the journal already holds, nothing
// it sends is written except context usage.

import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type {
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionStartedEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  ACP_REOPEN_FAILED,
  acpReopenTakeover,
  acpSessionNotRestoredRow
} from './acp-session-reopen-failure'
import { ACP_HANDLE_TRANSPORT, acpAgentName } from './acp-structured-agent-definitions'
import { probeAcpChildStop } from './acp-structured-child-stop'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredLane } from './acp-structured-lane'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { restoreAcpSessionOptions, type AcpStructuredOptions } from './acp-structured-options'
import type { AcpStructuredPrompts } from './acp-structured-prompts'
import type { AcpStructuredSession } from './acp-structured-session'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import { AcpStructuredTurns, type AcpStructuredTurnsDeps } from './acp-structured-turns'
import { assertAcpStartingSession, type AcpStartingSession } from './acp-structured-child'

type AcpHandshakeInput = {
  acquire: StructuredAgentSessionAcquireInput
  deps: AcpStructuredSessionAdapterDeps
  generation: string
  launch: AcpStructuredLaunch
  connection: AcpStructuredConnection
  options: AcpStructuredOptions
  prompts: AcpStructuredPrompts
  starting: AcpStartingSession
  abandoned: () => boolean
  lanes: {
    create: (providerSessionId: string, attaching?: boolean) => AcpStructuredLane
    clear: () => void
    finishLoad: () => void
  }
  onSettled: AcpStructuredTurnsDeps['settle']
  onReady: (session: AcpStructuredSession, event: StructuredAgentSessionStartedEvent) => void
}

export async function initializeAcpStructuredSession(input: AcpHandshakeInput): Promise<void> {
  const { acquire, deps, generation, launch, connection, options, prompts, starting, onSettled } =
    input
  const { spec } = deps
  const sessionId = acquire.identity.sessionId
  const now = deps.now ?? Date.now
  const assertStarting = () => assertAcpStartingSession(starting, input.abandoned)
  const agentName = acpAgentName(spec.agent)
  const optionRevision = acquire.optionRevision?.() ?? 0
  assertStarting()
  const initialized = await connection.initialize()
  starting.startupAnswered = true
  assertStarting()
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
    const attaching = input.lanes.create(resume.sessionId, true)
    liveLane = attaching
    try {
      started = await connection.start({
        cwd: launch.cwd,
        mcpServers: [],
        sessionId: resume.sessionId,
        ...auth
      })
      assertStarting()
      input.lanes.finishLoad()
      attaching.translator.finishLoad()
    } catch (error) {
      assertStarting()
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
    input.lanes.clear()
    started = await connection.start({ cwd: launch.cwd, mcpServers: [], ...auth })
    assertStarting()
    liveLane = input.lanes.create(started.sessionId)
  }
  const subagentStopSupported = await probeAcpChildStop(connection, spec.dialect)
  assertStarting()
  options.adoptSession(started.response, started.kind === 'new' ? 'new' : 'loaded')
  liveLane.apply(liveLane.translator.contextModels(started.response.models, now()))
  const restoreSkipped = await restoreAcpSessionOptions(connection, options, acquire.options)
  assertStarting()
  const link: AgentSessionProviderHandleLink = {
    linkId:
      deps.mintLinkId?.() ?? `${spec.agent}-${acquire.fence}-${started.sessionId}`.slice(0, 128),
    handle: { transport: ACP_HANDLE_TRANSPORT, agent: spec.agent, nativeId: started.sessionId },
    origin: started.kind === 'new' ? 'created' : 'resumed',
    mintedAtFence: acquire.fence,
    observedAt: now(),
    ...takeover
  }
  const ready: AcpStructuredSession = {
    phase: 'ready',
    sessionId,
    fence: acquire.fence,
    acquisitionGeneration: generation,
    spec,
    subagentStopSupported,
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
      settle: onSettled
    }),
    closeRequested: false,
    journalClosed: null,
    ended: false,
    exitObservedAt: null
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
    ready.unbindReadingControl = unbind
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
  assertStarting()
  input.onReady(ready, {
    type: 'started',
    sessionId,
    fence: acquire.fence,
    acquisitionGeneration: generation,
    link,
    reportedOptions: options.read().current,
    restoreSkippedOptions: restoreSkipped,
    optionRevision,
    // Its saved picks restored: what it runs now is what its start resolved.
    catalogListing: options.startListing()
  })
}
