// Makes a reservation real: spawn `zcode app-server --stdio`, open or resume the conversation,
// seed the journal from the snapshot, and hand the acquisition to the host.

import { randomUUID } from 'node:crypto'
import { zcodeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { openZcodeAppServerConnection } from './zcode-app-server-connection'
import { zcodeStructuredChildEnvironment } from './zcode-structured-child-environment'
import {
  readZcodeSessionEvent,
  readZcodePermissionRequest,
  readZcodeSnapshot,
  type ZcodeSessionSnapshotSummary
} from './zcode-protocol-events'
import {
  createZcodeJournalTranslator,
  type ZcodeJournalTranslator
} from './zcode-structured-journal-translation'
import type {
  ZcodeLivePrompt,
  ZcodeStructuredSession,
  ZcodeStructuredSessionAdapterDeps
} from './zcode-structured-session-state'

const CREATE_OR_RESUME_TIMEOUT_MS = 60_000

export type ZcodeAcquireOutcome = {
  acquisition: AgentSessionAcquisition
  session: ZcodeStructuredSession
}

export async function acquireZcodeStructuredSession(input: {
  acquire: StructuredAgentSessionAcquireInput
  deps: ZcodeStructuredSessionAdapterDeps
}): Promise<ZcodeAcquireOutcome> {
  const { acquire, deps } = input
  const sessionId = acquire.identity.sessionId
  const now = deps.now ?? Date.now
  let launch
  try {
    launch = await deps.resolveLaunch({ identity: acquire.identity })
  } catch (error) {
    throw error instanceof AgentSessionPreSpawnError ? error : new AgentSessionPreSpawnError(error)
  }

  const acquisitionGeneration = deps.mintAcquisitionGeneration?.() ?? randomUUID()
  const resumeSessionId = launch.resumeSessionId
  const childEnv = zcodeStructuredChildEnvironment(launch, sessionId)
  /** Shared with the session: prompts the child asks during and after acquire all land here. */
  const livePrompts = new Map<string, ZcodeLivePrompt>()

  let connection: Awaited<ReturnType<typeof openZcodeAppServerConnection>> | null = null
  let translator: ZcodeJournalTranslator | null = null
  let unbindReadingControl: (() => void) | undefined
  /** The start time read once at spawn; onSpawned's report and the acquisition must match. */
  let spawnIdentity: Promise<AgentSessionProcessIdentity> | undefined
  const identityAt = async (pid: number): Promise<AgentSessionProcessIdentity> => {
    spawnIdentity ??= (async () => ({
      hostId: acquire.identity.hostId,
      pid,
      processStartTimeMs: (await deps.readProcessStartTime?.(pid)) ?? null,
      spawnToken: acquire.spawnToken
    }))()
    return spawnIdentity
  }
  // Tests inject a whole fake connection opener (Codex's seam); production spawns the real child.
  const open: typeof openZcodeAppServerConnection =
    deps.openConnection ?? openZcodeAppServerConnection
  try {
    connection = await open(
      {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: { ...childEnv.env, ORCA_AGENT_SESSION_SPAWN_TOKEN: acquire.spawnToken },
        envToDelete: childEnv.envToDelete
      },
      {
        onSpawned: acquire.onSpawned
          ? async (pid: number) => {
              await acquire.onSpawned?.(await identityAt(pid))
            }
          : undefined,
        onNotification: (method, params) => {
          const event = readZcodeSessionEvent(method, params)
          if (event) {
            translator?.handle(event)
          }
        },
        onServerRequest: (request) => {
          // An approval or question the child waits on; held here, claimed by the session.
          const permission = readZcodePermissionRequest(request.method, request.params)
          if (permission) {
            const prompt: ZcodeLivePrompt = {
              itemId: `zcode-prompt-${request.id}`,
              kind: 'approval',
              requestId: request.id,
              method: request.method,
              params: request.params
            }
            livePrompts.set(prompt.itemId, prompt)
            translator?.announcePrompt({
              itemId: prompt.itemId,
              toolName: permission.toolName,
              detail: permission.reason ?? null,
              options: permission.options
                .filter((option) => option.optionId !== '')
                .map((option) => ({ id: option.optionId, label: option.name || option.optionId }))
            })
            return
          }
          // Create and resume cannot finish until Orca names the session's runtime
          // preferences; Orca runs none of the surfaces they switch on itself.
          if (request.method === 'session/requestRuntimePreferences') {
            connection?.respond(request.id, {
              nativeSearchEnhancementsEnabled: false,
              memoryEnabled: false,
              askUserQuestionAutoResolutionEnabled: true,
              modelContextBudgetStrategy: 'preflight-v1'
            })
            return
          }
          // Everything else the child asks, Orca refuses rather than leaves waiting forever.
          connection?.respondWithError(request.id, -32001, `orca does not answer ${request.method}`)
        },
        onExit: (error) => {
          translator?.dispose()
          deps.onExitObserved?.(error)
        },
        ...(acquire.onOutput ? { onOutput: acquire.onOutput } : {})
      }
    )

    // The journal sink exists before the child: events it emitted during startup land in order.
    translator = acquire.events
      ? createZcodeJournalTranslator({
          sessionId,
          sink: acquire.events,
          now
        })
      : null
    const snapshot = await openZcodeConversation(connection, launch, resumeSessionId, deps)
    if (!snapshot) {
      throw new Error('zcode app-server returned no session snapshot')
    }
    // The server streams `session/event` only once a subscribe names a delivery kind;
    // until then the chat would sit silent behind a running turn.
    await connection.request(
      'session/subscribe',
      { sessionId: snapshot.sessionId, deliveryKind: 'desktop-continuous' },
      { timeoutMs: deps.requestTimeoutMs ?? CREATE_OR_RESUME_TIMEOUT_MS }
    )
    translator?.restoreSnapshot(snapshot.messages)

    // The sink couples its durable-queue pressure to this child's stream; without the
    // binding a hard-watermark sink keeps admitting and the child's rows drop.
    if (connection.pauseReading && connection.resumeReading) {
      unbindReadingControl = acquire.events?.bindReadingControl?.({
        pauseReading: connection.pauseReading,
        resumeReading: connection.resumeReading
      })
    }

    const process = connection.pid === undefined ? null : await identityAt(connection.pid)
    const acquisition: AgentSessionAcquisition = {
      process: process ?? {
        hostId: acquire.identity.hostId,
        pid: 0,
        processStartTimeMs: null,
        spawnToken: acquire.spawnToken
      },
      link: {
        linkId: `zcode-${acquire.fence}-${snapshot.sessionId}`.slice(0, 128),
        handle: zcodeProviderHandle(snapshot.sessionId),
        origin: resumeSessionId ? 'resumed' : 'created',
        mintedAtFence: acquire.fence,
        observedAt: now()
      },
      acquisitionGeneration
    }
    const session: ZcodeStructuredSession = {
      connection,
      providerSessionId: snapshot.sessionId,
      acquisitionGeneration,
      fence: acquire.fence,
      translator,
      ended: false,
      exitObservedAt: null,
      orcaClose: false,
      prompts: livePrompts,
      options: new Map(Object.entries(acquire.options ?? {})),
      launch,
      ...(unbindReadingControl ? { unbindReadingControl } : {})
    }
    return { acquisition, session }
  } catch (error) {
    unbindReadingControl?.()
    translator?.dispose()
    if (connection) {
      const proven = await connection.close().catch(() => false)
      if (!proven) {
        throw new AgentSessionAcquisitionExitUnprovenError(error)
      }
    }
    throw error
  }
}

/** `session/resume` when the record proved a conversation, else `session/create` for the workspace. */
async function openZcodeConversation(
  connection: Awaited<ReturnType<typeof openZcodeAppServerConnection>>,
  launch: Awaited<ReturnType<ZcodeStructuredSessionAdapterDeps['resolveLaunch']>>,
  resumeSessionId: string | null,
  deps: ZcodeStructuredSessionAdapterDeps
): Promise<ZcodeSessionSnapshotSummary> {
  const timeoutMs = { timeoutMs: deps.requestTimeoutMs ?? CREATE_OR_RESUME_TIMEOUT_MS }
  if (resumeSessionId) {
    const resumed = readZcodeSnapshot(
      await connection.request('session/resume', { sessionId: resumeSessionId }, timeoutMs)
    )
    if (resumed && resumed.sessionId === resumeSessionId) {
      return resumed
    }
    if (resumed) {
      // A resume that minted a different conversation is a fork wearing the resume's name.
      throw new Error(
        `zcode resumed session ${resumed.sessionId} when asked for ${resumeSessionId}`
      )
    }
    throw new Error('zcode app-server returned no snapshot for the resumed session')
  }
  const created = readZcodeSnapshot(
    await connection.request(
      'session/create',
      {
        workspace: {
          workspacePath: launch.workspacePath,
          workspaceKey: launch.workspacePath
        }
      },
      timeoutMs
    )
  )
  if (!created) {
    throw new Error('zcode app-server returned no snapshot for the created session')
  }
  return created
}
