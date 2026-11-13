import type { StructuredAgentSessionProviderOpenResult } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import { providerTimelineSink } from '../../../native-chat/agent-session-timeline/provider-timeline-plan'
import { ZcodeStructuredLane } from '../timeline/zcode-structured-lane'
import {
  pushZcodeAccountConfig,
  readZcodeBuiltinTable
} from '../credentials/zcode-account-config-push'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { ZcodeStructuredSession } from './zcode-structured-session'

// The open handshake: push the account snapshot, create or resume the provider session,
// subscribe to its event stream, then apply the launch's model choice to a new session.

const MODE_BY_PERMISSION: Record<string, string> = {
  ask: 'build',
  'accept-edits': 'edit',
  auto: 'auto',
  'full-access': 'yolo'
}

export async function openZcodeSession(
  session: ZcodeStructuredSession,
  signal: AbortSignal
): Promise<StructuredAgentSessionProviderOpenResult> {
  const sessionId = session.deps.acquire.identity.sessionId
  const timeout = session.deps.requestTimeoutMs
  const throwIfAborted = (): void => {
    signal.throwIfAborted()
  }
  throwIfAborted()
  const table = readZcodeBuiltinTable(
    session.deps.launch.providerEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null
  )
  if (!session.accountPushed) {
    const firstPush = await pushZcodeAccountConfig(
      session.connection,
      table,
      session.deps.resolveChatCredentials()
    )
    session.accountPushed = firstPush.pushed
    session.declareModels(firstPush.declaredModels)
    if (firstPush.refusedStandaloneAccount) {
      session.deps.logger?.warn('zcode CLI refused the account push; its models stay unavailable', {
        scope: 'zcode-account-push',
        sessionId
      })
    }
    throwIfAborted()
  }
  const mode =
    session.deps.launch.permissionMode === undefined
      ? undefined
      : MODE_BY_PERMISSION[session.deps.launch.permissionMode]
  let providerSessionId: string | null = null
  if (session.deps.resumeSessionId) {
    providerSessionId = await resumeSession(session, session.deps.resumeSessionId, signal)
  }
  if (!providerSessionId) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
    const created = (await session.connection.request(
      'session/create',
      {
        workspace: { ...workspaceParams(session) },
        ...(mode ? { mode } : {})
      },
      { timeoutMs: timeout, onReply: throwIfAborted }
    )) as { session?: unknown } | null
    providerSessionId = readString(readRecord(readRecord(created)?.session)?.sessionId)
  }
  if (!providerSessionId) {
    throw new Error('zcode app-server opened no session id')
  }
  session.providerSessionId = providerSessionId
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
  const subscription = (await session.connection.request(
    'session/subscribe',
    {
      sessionId: providerSessionId,
      deliveryKind: 'desktop-continuous',
      includeSnapshot: true,
      afterSeq: 0
    },
    { timeoutMs: timeout, onReply: throwIfAborted }
  )) as { snapshot?: unknown } | null
  throwIfAborted()
  const laneSink = providerTimelineSink(session.sinkForOpen())
  if (!laneSink) {
    throw new Error('zcode chats need a journal sink that accepts transitions')
  }
  session.lane = new ZcodeStructuredLane({
    sink: laneSink,
    sessionId,
    agent: 'zcode',
    generation: session.deps.generation,
    providerSessionId,
    logger: session.deps.logger ?? createStructuredAgentSessionLogger(),
    now: session.deps.now,
    onInputAccepted: (clientMessageId, providerTurnId, providerMessageId) =>
      session.turns.accept(
        clientMessageId,
        providerTurnId,
        providerMessageId ?? session.lane?.translator.inputMessageIdOf(providerTurnId) ?? null
      ),
    onFailed: (reason) =>
      session.deps.forceClose(
        sessionId,
        `Orca stopped ZCode after its chat journal refused a write (${reason})`
      )
  })
  adoptSnapshot(session, subscription?.snapshot)
  // Queued frames land before any live event can arrive during the model-write await.
  session.drainEarly()
  // The person's saved model applies to new and resumed sessions alike: zcode's resumed
  // conversations keep their history but re-open on the backend's own last-used model.
  if (session.deps.launch.model) {
    const model = session.deps.launch.model
    await session.options
      .write(
        session.connection,
        providerSessionId,
        'model',
        `${model.providerId}/${model.modelId}`,
        timeout
      )
      .catch(() => undefined)
    if (model.reasoningLevel) {
      await session.options
        .write(session.connection, providerSessionId, 'effort', model.reasoningLevel, timeout)
        .catch(() => undefined)
    }
  }
  session.publishOptionsFromOpen()
  return {
    link: {
      linkId: `zcode-${session.deps.acquire.fence}-${providerSessionId}`.slice(0, 128),
      handle: { transport: 'zcode-app-server', agent: 'zcode', nativeId: providerSessionId },
      // Continuing a rewind fork changes the chain's root: it is a fork of the head, not a resume.
      ...(session.deps.launch.forkedFromKey
        ? {
            origin: 'forked' as const,
            forkedFromKey: session.deps.launch.forkedFromKey
          }
        : { origin: session.deps.resumeSessionId ? ('resumed' as const) : ('created' as const) }),
      mintedAtFence: session.deps.acquire.fence,
      observedAt: session.deps.now()
    },
    reportedOptions: session.options.live(null).current
  }
}

async function resumeSession(
  session: ZcodeStructuredSession,
  resumeSessionId: string,
  signal: AbortSignal
): Promise<string | null> {
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
    const resumed = (await session.connection.request(
      'session/resume',
      { sessionId: resumeSessionId, workspace: { ...workspaceParams(session) } },
      { timeoutMs: session.deps.requestTimeoutMs, onReply: () => signal.throwIfAborted() }
    )) as { session?: unknown } | null
    return readString(readRecord(readRecord(resumed)?.session)?.sessionId)
  } catch (error) {
    signal.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    // Only an unknown/ended session restarts the conversation fresh; a timeout or lost
    // connection must not silently replace the provider history.
    if (/Session is not active|not found|Unknown session/u.test(message)) {
      return null
    }
    throw error
  }
}

function workspaceParams(session: ZcodeStructuredSession): {
  workspacePath: string
  workspaceKey: string
} {
  return { workspacePath: session.deps.launch.cwd, workspaceKey: session.deps.launch.cwd }
}

/** Replay the subscribe snapshot's projection facts; message rows come from live replays. */
function adoptSnapshot(session: ZcodeStructuredSession, snapshot: unknown): void {
  const record = readRecord(snapshot)
  const settings = readRecord(record?.settings)
  if (settings) {
    session.options.adoptProjectionSettings(settings)
    // The push's declared list plus the snapshot's own level menu keep every plan model
    // selectable; the backend's `model.available` names only the live selection.
    const thought = readRecord(settings?.thoughtLevel)
    const levels = Array.isArray(thought?.available)
      ? thought.available.flatMap((level) => {
          const item = readRecord(level)
          const value = readString(item?.value)
          return value ? [{ value, label: readString(item?.label) ?? value }] : []
        })
      : undefined
    session.adoptDeclaredModelLevels(levels)
  }
  const projection = readRecord(record?.projection)
  const window = typeof projection?.contextWindow === 'number' ? projection.contextWindow : null
  if (window !== null) {
    session.adoptSnapshotContextWindow(window)
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
