import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeStreamJsonConnectionHandlers } from '../../../claude-stream-json-connection'
import {
  journalSqlReads,
  type JournalSqlReads
} from '../../../../native-chat/agent-session-journal/journal-sql-reads'
import type { StructuredAgentSessionHistoryJournal } from '../../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-journal-views'
import type { StructuredAgentSessionEventSink } from '../../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  ClaudeAcquisitionRegistry,
  type ClaudeSession,
  type ClaudeStructuredSessionAdapterDeps
} from '../../claude-structured-session-state'
import { acquireClaudeSession } from '../../lifecycle/claude-structured-session-acquisition'
import type { ClaudeStructuredSessionEvent } from '../../lifecycle/claude-structured-session-event'
import { openClaudeStructuredSession } from '../../startup/claude-structured-session-open'
import { permissionTestSession } from './claude-permission.test-fixture'

export async function acquireFullAccessPermissionTestSession(
  newestItemId: JournalSqlReads['newestItemId'],
  reply: (mode: PermissionMode) => Promise<void>
) {
  const fixture = permissionTestSession('bypassPermissions', reply)
  const { providerSessionId, connection, fence } = fixture.session
  const reads = {
    ...journalSqlReads(
      {
        point: async () => {
          throw new Error('Unexpected journal read')
        }
      },
      'session'
    ),
    newestItemId,
    historyOrigin: async () => null
  }
  const journal: StructuredAgentSessionHistoryJournal = {
    reads,
    cursor: () => ({ epoch: 'epoch', sequence: 0 }),
    readInOrder: async (read) => read(reads)
  }
  let bound = false
  let notifyBound = () => {}
  let onMessage: ClaudeStreamJsonConnectionHandlers['onMessage']
  const events: StructuredAgentSessionEventSink = {
    ...fixture.events,
    journalHistory: () => (bound ? journal : null),
    journalSnapshot: () =>
      bound
        ? {
            canonicalByToolUse: [],
            attemptByAgent: [],
            parents: [],
            backgrounds: [],
            subagents: [],
            threadGoal: { goal: null, row: null }
          }
        : null,
    onJournalBound: (listener) => {
      notifyBound = listener
      return () => {
        notifyBound = () => {}
      }
    }
  }
  const sessionId = 'session'
  const sessions = new Map<string, ClaudeSession>()
  const emit = (session: ClaudeSession | null, event: ClaudeStructuredSessionEvent) =>
    session?.translator?.handle(event)
  const deps: ClaudeStructuredSessionAdapterDeps = {
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: { permissionMode: 'bypassPermissions' },
      cwd: '/workspace',
      claudeConfigDir: '/claude',
      providerSessionId,
      resumeLeafUuid: null,
      resumesTranscript: true,
      continuesChain: true,
      cliFlag: async () => 'unknown'
    }),
    readProcessStartTime: async () => 1,
    openConnection: async (_launch, handlers) => {
      onMessage = handlers.onMessage
      return {
        ...connection,
        pid: 1,
        initializationResult: async () => ({ current_permission_mode: 'default' })
      }
    }
  }
  const { acquisitionGeneration } = await acquireClaudeSession({
    input: {
      identity: {
        sessionId,
        hostId: 'host',
        workspaceId: 'workspace',
        agent: 'claude',
        providerHandle: null
      },
      events,
      fence,
      spawnToken: 'spawn'
    },
    deps,
    sessions,
    acquisitions: new ClaudeAcquisitionRegistry(),
    exits: new Map(),
    callbacks: {
      publish: (session) => {
        sessions.set(sessionId, session)
      },
      deliver: (attempt, _sessionId, run, payload) => attempt.delivery.deliver(run, payload),
      emit: (session, _events, event) => emit(session, event),
      handleExit: () => {},
      finishClose: () => {},
      settleExit: async () => {}
    }
  })
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error('Expected a published Claude session')
  }
  return {
    session,
    rows: fixture.rows,
    writes: fixture.writes,
    init: () =>
      onMessage?.({
        type: 'system',
        subtype: 'init',
        session_id: providerSessionId,
        permissionMode: 'default'
      }),
    bind: () => {
      bound = true
      notifyBound()
    },
    open: () =>
      openClaudeStructuredSession({
        request: { sessionId, fence, acquisitionGeneration, signal: new AbortController().signal },
        session,
        sessions,
        deps,
        emit
      })
  }
}
