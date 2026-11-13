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

// Start one zcode app-server child per acquisition, routed to its session from spawn time. A CLI
// that refuses the host's account push (standalone-account runtimes) is replaced by the desktop
// bundle's runtime, which accepts it — that push decides the chat's model inventory.

const STORAGE_READY_TIMEOUT_MS = 15_000
const STORAGE_READY_ATTEMPT_TIMEOUT_MS = 2_000
const STORAGE_READY_RETRY_INTERVAL_MS = 1_000
const ZCODE_APP_SERVER_ARGS = ['app-server', '--stdio']

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
  let child = await spawnWiredChild(input, logger, input.launch)
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
    await child.connection.close().catch(() => undefined)
    throw error
  })
  child.session.declareModels(probe.declaredModels)
  if (probe.refusedStandaloneAccount && input.launch.fallbackRuntime) {
    logger.warn('zcode CLI refused the account push; retrying on the desktop runtime', {
      scope: 'zcode-account-push',
      sessionId: acquire.identity.sessionId
    })
    child.session.markJournalClosed('replaced by the desktop runtime')
    await child.connection.close().catch(() => false)
    const fallback = input.launch.fallbackRuntime
    const retryLaunch: ZcodeStructuredLaunch = {
      ...input.launch,
      command: fallback.command,
      prefixArgs: [],
      args: [...fallback.args, ...ZCODE_APP_SERVER_ARGS],
      providerEnv: { ...input.launch.providerEnv, ...fallback.env }
    }
    child = await spawnWiredChild(input, logger, retryLaunch)
    const retryTable = readZcodeBuiltinTable(
      retryLaunch.providerEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null
    )
    const retry = await awaitStorageReady(
      child.connection,
      child.whenServerAsks,
      () =>
        pushZcodeAccountConfig(
          child.connection,
          retryTable,
          deps.resolveChatCredentials(),
          STORAGE_READY_ATTEMPT_TIMEOUT_MS
        ),
      acquire.signal
    ).catch(async (error: unknown) => {
      await child.connection.close().catch(() => undefined)
      throw error
    })
    child.session.accountPushed = retry.pushed
    child.session.declareModels(retry.declaredModels)
  } else {
    child.session.accountPushed = probe.pushed
  }
  return {
    session: child.session,
    process: await child.process,
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
  let routes: {
    notification: (method: string, params: unknown) => void
    serverRequest: (method: string, params: unknown, id: number | string) => void
  } = {
    notification: () => undefined,
    serverRequest: () => announceServerAsk?.()
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
  return child
}

/**
 * The start's verdict: zcode's own request refusals are final, everything else stays retryable,
 * and a process exit words the start as the agent's failure to boot.
 */
export function zcodeStartFailure(error: unknown, exited = false): AgentSessionStartFailure {
  return agentSessionStartFailure(
    error,
    (cause) => (cause instanceof ZcodeAppServerRequestError ? 'final' : undefined),
    exited
  )
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
