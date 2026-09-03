import { randomUUID } from 'node:crypto'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { acpSpawnRecipe, isAcpStructuredAgent } from '../../shared/acp-agent-recipes'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type {
  AgentSessionAcquisition,
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent,
  StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'
import {
  openAcpJsonRpcConnection,
  type AcpJsonRpcConnection,
  type AcpJsonRpcLaunch
} from './acp-jsonrpc-connection'
import {
  applyAcpSessionOption,
  indexAcpConfigOptions,
  type AcpConfigIndex
} from './acp-session-config'
import {
  acpPromptBlocks,
  applyAcpServerRequest,
  applyAcpSessionUpdate,
  type AcpPendingPrompt
} from './acp-session-events'
import {
  acpProviderHandle,
  acpResumeSessionId,
  authenticateAcpConnection
} from './acp-session-identity'

export type AcpStructuredSessionAdapterDeps = {
  openConnection?: typeof openAcpJsonRpcConnection
  resolveLaunch: (input: {
    identity: StructuredAgentSessionAcquireInput['identity']
    spawnToken: string
  }) => Promise<AcpJsonRpcLaunch>
  readProcessStartTime: (pid: number) => Promise<number | null>
  now?: () => number
  onEvent?: (event: StructuredAgentSessionLifecycleEvent) => void
}

type AcpSession = {
  connection: AcpJsonRpcConnection
  acpSessionId: string
  agent: string
  fence: number
  acquisitionGeneration: string
  imageCapable: boolean
  config: AcpConfigIndex
  pendingPermissions: Map<string, AcpPendingPrompt>
  promptCount: number
  assistant: { text: string }
}

export class AcpStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, AcpSession>()
  private readonly openConnection: typeof openAcpJsonRpcConnection

  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {
    this.openConnection = deps.openConnection ?? openAcpJsonRpcConnection
  }

  supportsCreate = (
    location: Parameters<NonNullable<StructuredAgentSessionAdapter['supportsCreate']>>[0],
    agent: string
  ): boolean =>
    isAcpStructuredAgent(agent) &&
    Boolean(acpSpawnRecipe(agent)) &&
    supportsCodexStructuredLocation(location)

  supportsLocation = supportsCodexStructuredLocation

  acquire = async (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> => {
    const agent = input.identity.agent
    if (!acpSpawnRecipe(agent)) {
      throw new Error(`ACP Chat UI does not support ${agent}`)
    }
    const launch = await this.deps.resolveLaunch({
      identity: input.identity,
      spawnToken: input.spawnToken
    })
    const generation = randomUUID()
    const live: { connection?: AcpJsonRpcConnection } = {}
    const connection = await this.openConnection(launch, {
      onNotification: (method, params) => {
        if (method !== 'session/update') {
          return
        }
        const session = this.sessions.get(input.identity.sessionId)
        applyAcpSessionUpdate({
          sessionId: input.identity.sessionId,
          agent: session?.agent ?? input.identity.agent,
          acpSessionId: session?.acpSessionId ?? input.identity.sessionId,
          assistantRecordId: `assistant-${session?.promptCount ?? 0}`,
          ...(session ? { assistant: session.assistant } : {}),
          params,
          events: input.events
        })
      },
      onServerRequest: (request) => {
        const session = this.sessions.get(input.identity.sessionId)
        const handled = applyAcpServerRequest({
          sessionId: input.identity.sessionId,
          agent: session?.agent ?? input.identity.agent,
          acpSessionId: session?.acpSessionId ?? input.identity.sessionId,
          request,
          pending: session?.pendingPermissions ?? new Map(),
          events: input.events
        })
        if (handled === 'ignored') {
          live.connection?.respondError(request.id, -32601, `Unknown ACP method ${request.method}`)
        }
      },
      onExit: () => {
        const session = this.sessions.get(input.identity.sessionId)
        if (!session || session.connection !== connection) {
          return
        }
        this.deps.onEvent?.({
          type: 'ended',
          sessionId: input.identity.sessionId,
          reason: 'ACP child exited',
          cause: 'unexpected-exit',
          fence: session.fence,
          acquisitionGeneration: session.acquisitionGeneration
        })
      }
    })
    live.connection = connection
    const pid = connection.pid
    if (pid === undefined) {
      await connection.close()
      throw new Error('ACP child started without a pid')
    }
    const processStartTimeMs = await this.deps.readProcessStartTime(pid)
    if (processStartTimeMs === null) {
      await connection.close()
      throw new Error(`ACP child start time for pid ${pid} could not be read`)
    }
    await authenticateAcpConnection(agent, connection)
    const cwd = launch.cwd
    if (!cwd) {
      await connection.close()
      throw new Error('ACP session cwd is required')
    }
    const loadedId = acpResumeSessionId(input.identity)
    const useLoad = Boolean(loadedId && connection.initialize.agentCapabilities?.loadSession)
    const created = (await connection.request(
      useLoad ? 'session/load' : 'session/new',
      useLoad ? { sessionId: loadedId, cwd, mcpServers: [] } : { cwd, mcpServers: [] }
    )) as { sessionId?: string; configOptions?: { id?: string; currentValue?: unknown }[] }
    const acpSessionId = created.sessionId ?? loadedId
    if (!acpSessionId) {
      await connection.close()
      throw new Error('ACP session/new did not return a session id')
    }
    const config = indexAcpConfigOptions(created.configOptions ?? [])
    this.sessions.set(input.identity.sessionId, {
      connection,
      acpSessionId,
      agent,
      fence: input.fence,
      acquisitionGeneration: generation,
      imageCapable: connection.initialize.agentCapabilities?.promptCapabilities?.image === true,
      config,
      pendingPermissions: new Map(),
      promptCount: 0,
      assistant: { text: '' }
    })
    const observedAt = this.deps.now?.() ?? Date.now()
    return {
      process: {
        hostId: input.identity.hostId,
        pid,
        processStartTimeMs,
        spawnToken: input.spawnToken
      },
      link: {
        linkId: `acp-${input.fence}-${acpSessionId}`.slice(0, 128),
        handle: acpProviderHandle(agent, acpSessionId),
        origin: useLoad ? 'resumed' : 'created',
        mintedAtFence: input.fence,
        observedAt
      },
      acquisitionGeneration: generation
    }
  }

  dispatch = async (input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
  }): Promise<AgentSessionDispatchOutcome> => {
    const session = this.sessions.get(input.sessionId)
    if (!session) {
      return { state: 'rejected', reason: 'ACP session is not live' }
    }
    const prompt = acpPromptBlocks(input.body, session.imageCapable)
    if (!prompt.ok) {
      return { state: 'rejected', reason: prompt.reason }
    }
    session.promptCount += 1
    session.assistant.text = ''
    const turnId = `acp-turn-${session.promptCount}`
    try {
      await session.connection.request(
        'session/prompt',
        {
          sessionId: session.acpSessionId,
          prompt: prompt.prompt
        },
        { timeoutMs: 0 }
      )
    } catch (error) {
      return {
        state: 'unknown',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
    return {
      state: 'accepted',
      providerIdentity: {
        provider: 'legacy',
        agent: session.agent,
        sessionId: session.acpSessionId,
        recordId: `${turnId}:user`
      }
    }
  }

  cancelTurn = async (input: {
    sessionId: string
    turnId: string
    fence: number
  }): Promise<{ cancelled: boolean }> => {
    const session = this.sessions.get(input.sessionId)
    if (!session) {
      return { cancelled: false }
    }
    session.connection.notify('session/cancel', { sessionId: session.acpSessionId })
    return { cancelled: true }
  }

  answerPrompt = async (input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }): Promise<void> => {
    const session = this.sessions.get(input.sessionId)
    const identity = parseAgentJournalItemKey(input.itemId)
    const pendingKey = identity?.provider === 'legacy' ? identity.recordId : input.itemId
    const pending = session?.pendingPermissions.get(pendingKey)
    if (!session || !pending) {
      return
    }
    session.pendingPermissions.delete(pendingKey)
    if (pending.kind === 'question') {
      session.connection.respond(pending.id, {
        answers: [{ id: input.itemId, optionId: input.optionId }]
      })
      return
    }
    session.connection.respond(pending.id, {
      outcome: { outcome: 'selected', optionId: input.optionId }
    })
  }

  setOption = async (
    input: StructuredAgentSessionSetOptionInput
  ): Promise<void | Readonly<Record<string, string>>> => {
    const session = this.sessions.get(input.sessionId)
    if (!session) {
      return
    }
    try {
      session.config = await applyAcpSessionOption({
        connection: session.connection,
        acpSessionId: session.acpSessionId,
        config: session.config,
        key: input.key,
        value: input.value
      })
    } catch (error) {
      throw new AgentSessionOptionRejectedError(error)
    }
    return Object.fromEntries(session.config.values)
  }

  readOptions = async (input: { sessionId: string; fence: number }) =>
    this.sessions.get(input.sessionId)?.config.result ?? { models: [], current: { model: '' } }

  closeSession = async (sessionId: string): Promise<boolean> => {
    const session = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    return session ? session.connection.close() : true
  }

  disposeSession = (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.closeSession(input.sessionId)
  closeAll = async (): Promise<void> => {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)))
  }
}
