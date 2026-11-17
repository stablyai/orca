import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { providerSpawnedProcessIdentity } from '../../../provider-process/provider-spawned-process-identity'
import type { AgentSessionProcessIdentity } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  createStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { AgentSessionPreSpawnError } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { StructuredAgentSessionAcquireInput } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { providerTimelineSink } from '../../../native-chat/agent-session-timeline/provider-timeline-plan'
import { spawnZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection'
import type { ZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection-types'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import {
  agentSessionStartFailure,
  type AgentSessionStartAnswer,
  type AgentSessionStartFailure
} from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import { ZcodeAppServerRequestError } from '../../app-server/zcode-app-server-errors'
import {
  pushZcodeAccountConfig,
  readZcodeBuiltinTable
} from '../credentials/zcode-account-config-push'
import { ZcodeStructuredSession } from './zcode-structured-session'
import type { ZcodeSendSettlement } from '../turns/zcode-structured-turns'
import type {
  ZcodeStructuredLaunch,
  ZcodeStructuredSessionAdapterDeps
} from './zcode-structured-session-state'

// Start one zcode app-server child per acquisition, routed to its session from spawn time. The
// account push decides the chat's model inventory; a CLI that refuses it (standalone-account
// runtimes) starts anyway — bundle-first launches already prefer the runtime that accepts it.

const STORAGE_READY_TIMEOUT_MS = 15_000
const STORAGE_READY_ATTEMPT_TIMEOUT_MS = 2_000
const STORAGE_READY_RETRY_INTERVAL_MS = 1_000

export type ZcodeStartedChild = {
  session: ZcodeStructuredSession
  process: AgentProcessIdentity
  generation: string
}

export async function startZcodeStructuredSession(input: {
  acquire: StructuredAgentSessionAcquireInput
  deps: ZcodeStructuredSessionAdapterDeps
  launch: ZcodeStructuredLaunch
  generation: string
  events: StructuredAgentSessionEventSink | undefined
  forceClose: (sessionId: string, reason: string) => void
  /** A cleanup whose exit proof failed; release and shutdown keep reaping the retained child. */
  retainFailedStart: (sessionId: string, session: ZcodeStructuredSession) => void
  onSettled: (settlement: ZcodeSendSettlement) => void
  /** The adapter's start-failure registry, so a dead child's open answers with its verdict. */
  recordStartFailure: (failure: AgentSessionStartFailure) => void
}): Promise<ZcodeStartedChild> {
  const { acquire, deps, events } = input
  const logger = deps.logger ?? createStructuredAgentSessionLogger()
  const sink = events ? providerTimelineSink(events) : null
  if (!sink) {
    throw new AgentSessionPreSpawnError(new Error('zcode chats need a journal sink'))
  }
  const child = await spawnWiredChild(input, logger, input.launch)
  // Whether this runtime accepts the host's account push decides its model inventory, so probe
  // it here while the start can still switch to the desktop runtime.
  const table = readZcodeBuiltinTable(
    child.launch.providerEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null
  )
  // The child already exists before readiness settles: cancellation or a readiness failure
  // must close it here, while this function is still its only owner.
  const probe = await awaitStorageReady(
    child.connection,
    child.whenServerAsks,
    () =>
      pushZcodeAccountConfig(
        child.connection,
        table,
        deps.resolveChatCredentials(),
        STORAGE_READY_ATTEMPT_TIMEOUT_MS
      ),
    acquire.signal
  ).catch(async (error: unknown) => {
    // A close that cannot prove exit leaves the child alive: retain it so release and
    // shutdown can still reap it, instead of discarding an owned process.
    const proven = await child.connection.close().catch(() => false)
    if (!proven) {
      input.retainFailedStart(acquire.identity.sessionId, child.session)
    }
    throw error
  })
  child.session.declareModels(probe.declaredModels)
  child.session.accountPushed = probe.pushed
  // A rejected process identity (persist failure) must not orphan the running app-server: the
  // adapter owns nothing until sessions.set, so this function closes the child like the
  // readiness path does.
  const process = await child.process.catch(async (error: unknown) => {
    const proven = await child.connection.close().catch(() => false)
    if (!proven) {
      input.retainFailedStart(acquire.identity.sessionId, child.session)
    }
    throw error
  })
  return {
    session: child.session,
    process,
    generation: input.generation
  }
}

type WiredChild = {
  connection: ZcodeAppServerConnection
  session: ZcodeStructuredSession
  launch: ZcodeStructuredLaunch
  process: Promise<AgentProcessIdentity>
  /** Resolves on the backend's first server→client ask — its own readiness announcement. */
  whenServerAsks: Promise<void>
}

type AgentProcessIdentity = AgentSessionProcessIdentity

async function spawnWiredChild(
  input: {
    acquire: StructuredAgentSessionAcquireInput
    deps: ZcodeStructuredSessionAdapterDeps
    launch: ZcodeStructuredLaunch
    generation: string
    events: StructuredAgentSessionEventSink | undefined
    forceClose: (sessionId: string, reason: string) => void
    onSettled: (settlement: ZcodeSendSettlement) => void
    recordStartFailure: (failure: AgentSessionStartFailure) => void
  },
  logger: StructuredAgentSessionLogger,
  launch: ZcodeStructuredLaunch
): Promise<WiredChild> {
  const { acquire, deps, events } = input
  const identity = providerSpawnedProcessIdentity(
    acquire,
    'zcode app-server',
    deps.readProcessStartTime
  )
  // Frames can arrive before the session object exists; route them through this holder. The
  // backend's first ask still counts, so readiness detection covers the pre-session window.
  let announceServerAsk: (() => void) | null = null
  const whenServerAsks = new Promise<void>((resolve) => {
    announceServerAsk = resolve
  })
  // The reader starts before the session routes are installed: everything that lands in that
  // window is buffered here and replayed once the session can answer — a dropped bootstrap ask
  // would leave zcode waiting for a reply that never comes.
  const earlyNotifications: { method: string; params: unknown }[] = []
  const earlyServerRequests: { method: string; params: unknown; id: number | string }[] = []
  let routes: {
    notification: (method: string, params: unknown) => void
    serverRequest: (method: string, params: unknown, id: number | string) => void
  } = {
    notification: (method, params) => {
      earlyNotifications.push({ method, params })
    },
    serverRequest: (method, params, id) => {
      announceServerAsk?.()
      earlyServerRequests.push({ method, params, id })
    }
  }
  let child: WiredChild | null = null
  const connection = await spawnZcodeAppServerConnection(
    {
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      // The composed agent environment carries the seal and PATH; provider tables ride on top.
      env: { ...launch.env, ...launch.providerEnv }
    },
    {
      onNotification: (method, params) => routes.notification(method, params),
      onServerRequest: (request) =>
        routes.serverRequest(request.method, request.params, request.id),
      onUnhandledFrame: (kind, payload) => {
        logger.warn('zcode app-server sent an unreadable frame', {
          scope: 'zcode-frame-unhandled',
          kind,
          payload
        })
      },
      onSpawned: (pid) => identity.onSpawned(pid),
      onExit: (error) => {
        const session = child?.session
        session?.markEnded(deps.now?.() ?? Date.now())
        // A child that died on its own before open answers for the start with its verdict.
        if (!session?.closeRequested) {
          input.recordStartFailure(zcodeStartFailure(error))
        }
        deps.onEvent?.({
          type: 'ended',
          sessionId: acquire.identity.sessionId,
          fence: acquire.fence,
          acquisitionGeneration: input.generation,
          reason: error.message,
          cause: session?.closeRequested ? 'requested-close' : 'unexpected-exit',
          failure: agentSessionFailureFact('providerExited'),
          observedAt: deps.now?.() ?? Date.now()
        })
      }
    }
  )
  const session = new ZcodeStructuredSession(
    connection,
    {
      acquire,
      generation: input.generation,
      launch,
      logger,
      now: deps.now ?? Date.now,
      requestTimeoutMs: deps.requestTimeoutMs ?? null,
      onEvent: (event) => deps.onEvent?.(event),
      resumeSessionId: launch.resumeSessionId,
      resolveChatCredentials: deps.resolveChatCredentials,
      forceClose: input.forceClose,
      onSettled: input.onSettled
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
    events as StructuredAgentSessionEventSink
  )
  routes = {
    notification: (method, params) => session.onNotification(method, params),
    serverRequest: (method, params, id) => {
      announceServerAsk?.()
      session.onServerRequest(method, params, id)
    }
  }
  child = { connection, session, launch, process: identity.read(connection.pid), whenServerAsks }
  // Live frames route straight from here; anything buffered before this line replays in order.
  for (const frame of earlyNotifications.splice(0)) {
    routes.notification(frame.method, frame.params)
  }
  for (const request of earlyServerRequests.splice(0)) {
    routes.serverRequest(request.method, request.params, request.id)
  }
  return child
}

/** zcode's own request refusals are final answers; exits are reported separately. */
export const zcodeStartAnswer: AgentSessionStartAnswer = (cause) =>
  cause instanceof ZcodeAppServerRequestError ? 'final' : undefined

/**
 * The start's verdict: zcode's own request refusals are final, everything else stays retryable,
 * and a process exit words the start as the agent's failure to boot.
 */
export function zcodeStartFailure(error: unknown, exited = false): AgentSessionStartFailure {
  return agentSessionStartFailure(error, zcodeStartAnswer, exited)
}

type ZcodeAccountPushProbe = Awaited<ReturnType<typeof pushZcodeAccountConfig>>

/**
 * The backend accepts nothing until its storage boots and announces readiness no other way than
 * accepting a request, so the boot is raced instead of parked: the account push (its acceptance
 * is the proof; a standalone-account refusal is final) and the runtime's first server→client ask
 * both end the wait inside the budget a blind sleep used to burn.
 */
async function awaitStorageReady(
  connection: ZcodeAppServerConnection,
  whenServerAsks: Promise<void>,
  push: () => Promise<ZcodeAccountPushProbe>,
  signal: AbortSignal | undefined
): Promise<ZcodeAccountPushProbe> {
  const deadline = Date.now() + STORAGE_READY_TIMEOUT_MS
  const noProbe: ZcodeAccountPushProbe = {
    pushed: false,
    refusedStandaloneAccount: false,
    refusedUnsupported: false,
    declaredModels: []
  }
  for (;;) {
    signal?.throwIfAborted()
    if (connection.closed) {
      return noProbe
    }
    const startedAt = Date.now()
    const outcome = await Promise.race([
      push().then((probe) => ({ kind: 'push' as const, probe })),
      whenServerAsks.then(() => ({ kind: 'asked' }) as const)
    ])
    if (outcome.kind === 'asked') {
      // The runtime takes requests now; one final push settles the account verdict.
      return await push()
    }
    if (outcome.probe.pushed || outcome.probe.refusedStandaloneAccount) {
      return outcome.probe
    }
    if (Date.now() >= deadline) {
      return outcome.probe
    }
    await delay(Math.max(0, startedAt + STORAGE_READY_RETRY_INTERVAL_MS - Date.now()), signal)
  }
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolveDelay()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}
