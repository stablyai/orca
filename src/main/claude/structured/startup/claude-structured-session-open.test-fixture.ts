import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { seedTestAgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import {
  openTestAgentSessionRecordStore,
  openTestAgentSessionDatabase
} from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from '../../../native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router.test-fixture'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { vi } from 'vitest'
import * as jsonlImport from '../../../native-chat/agent-session-journal/history-import/journal-jsonl-import'
import { chat, SESSION } from '../../transcripts/claude-transcript-catch-up.test-support'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonConnectionHandlers,
  openClaudeStreamJsonConnection
} from '../../claude-stream-json-connection'
import { ClaudeStructuredSessionAdapter } from '../claude-structured-session-adapter'

export function claudeWithSavedHistory(input: {
  providerSessionId: string
  cwd: string
  claudeConfigDir: string
  continuesChain?: true
  replayUuids?: string[]
}) {
  const { providerSessionId } = input
  const connections: (ClaudeStreamJsonConnection & {
    handlers: ClaudeStreamJsonConnectionHandlers
    sent: Record<string, unknown>[]
  })[] = []
  let replayIndex = 0
  const openConnection: typeof openClaudeStreamJsonConnection = async (launch, handlers = {}) => {
    let started = false
    let closed = false
    const sent: Record<string, unknown>[] = []
    const emit = (event: Record<string, unknown>) =>
      handlers.onMessage?.({ type: 'system', session_id: providerSessionId, ...event })
    const connection: (typeof connections)[number] = {
      handlers,
      sent,
      pid: 4321,
      get closed() {
        return closed
      },
      exitVerdict: { root: 'live', tree: 'unverifiable' },
      mcpServerStatus: async () => [],
      initializationResult: async () => {
        emit({ subtype: 'hook_started', hook_name: 'SessionStart:startup', uuid: 'init-uuid' })
        emit({
          subtype: 'hook_response',
          hook_name: 'SessionStart:startup',
          uuid: 'hook-response-uuid'
        })
        return { models: [{ value: 'claude-sonnet', displayName: 'Sonnet' }] }
      },
      renameSession: async () => {},
      getContextUsage: async () => ({}),
      getSettings: async () => ({
        applied: { model: 'claude-sonnet-5', effort: launch.options.effort ?? 'high' },
        effective: {
          model: 'claude-sonnet-5',
          ...(launch.options.effort ? {} : { effortLevel: 'high' })
        },
        sources: {}
      }),
      supportedModels: async () => [],
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {},
      interrupt: async () => undefined,
      cancelAsyncMessage: async () => false,
      stopTask: async () => {},
      backgroundTask: async () => false,
      send: async (message, beforeDispatch) => {
        await beforeDispatch?.()
        sent.push(message)
        if (message.type === 'user') {
          if (!started) {
            started = true
            emit({
              subtype: 'init',
              uuid: 'init-uuid',
              model: 'claude-sonnet-5',
              apiKeySource: 'none'
            })
          }
          handlers.onMessage?.({
            ...message,
            uuid: input.replayUuids?.[replayIndex++] ?? 'user-uuid'
          })
        }
      },
      close: async () => {
        closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async ({ spawnToken }) => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: input.cwd,
      claudeConfigDir: input.claudeConfigDir,
      providerSessionId,
      resumeLeafUuid: 'old-leaf',
      resumesTranscript: true,
      cliFlag: async () => 'supported',
      continuesChain: input.continuesChain ?? false,
      env: { [ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]: spawnToken }
    }),
    onEvent: () => {},
    openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    persistHandle: async () => {}
  })
  return { adapter, connections }
}

export async function restoredChatWithBlockedRecovery(
  cleanups: (() => Promise<void>)[],
  userSend?: true
) {
  const providerSessionId = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'
  const c = await chat('batch', providerSessionId)
  await c.journal.appendItem(
    { provider: 'claude', sessionId: providerSessionId, uuid: 'unheld-turn' },
    { kind: 'turn', turnId: 'unheld-turn', state: 'running' },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  const record = agentSessionRecordFixture({
    sessionId: SESSION,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: c.config },
    location: { workspaceId: 'workspace' },
    providerHandleChain: [
      {
        linkId: 'saved-link',
        handle: claudeProviderHandle(providerSessionId, 'old-leaf'),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 0
      }
    ]
  })
  await seedTestAgentSessionRecordStore(c.cwd, { records: [record] })
  const claude = claudeWithSavedHistory({
    providerSessionId,
    continuesChain: true,
    cwd: c.cwd,
    claudeConfigDir: c.config,
    replayUuids: ['held-echo', 'new-echo']
  })
  const { adapter } = claude
  const host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store: await openTestAgentSessionRecordStore(c.cwd),
    adapter,
    journalDatabase: await openTestAgentSessionDatabase(c.cwd),
    claimKeyId: 'test-key',
    mintSpawnToken: () => 'recovery-send',
    now: () => 1_800_000_000_000
  })
  const blocked = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const preparedImport = jsonlImport.prepareJsonlTranscriptImport
  vi.spyOn(jsonlImport, 'prepareJsonlTranscriptImport').mockImplementationOnce(async (input) => {
    const prepared = await preparedImport(input)
    blocked.resolve()
    await release.promise
    return prepared
  })
  cleanups.push(async () => {
    release.resolve()
    await host.flushAllStreamedEvents()
    await adapter.closeAll()
  })
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Keep my original send' }]
  }
  const send = (clientOperationId: string, message = body) =>
    host.send(
      { callerKey: 'test-client' },
      {
        envelope: {
          sessionId: SESSION,
          clientOperationId,
          expectedRuntimeFence: host.deps.store.getRecord(SESSION)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: SESSION,
            fields: { body: message }
          })
        },
        body: message,
        ...(userSend ? { userSend } : {})
      }
    )
  return { ...c, host, adapter, claude, blocked: blocked.promise, release, body, send }
}
