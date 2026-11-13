import { realpath } from 'node:fs/promises'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { assertAdoptedSourceIdentity } from '../native-chat/agent-session-journal/history-import/adopted-transcript-source'
import { createNewestItemWindow } from '../native-chat/agent-session-journal/history-import/journal-newest-item-window'
import { LEGACY_IMPORT_BLOCK_LIMITS } from '../native-chat/agent-session-journal/history-import/journal-legacy-import'
import { boundLegacyImportBody } from '../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { StructuredAgentRuntimeRegistration } from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { resolveTraexReadLaunch } from './traex-launch-resolution'
import { TraexAppServerConnection } from './traex-app-server-connection'
import { readTraexTurns } from './traex-thread-history'
import { projectTraexHistoryTurn } from './traex-history-projection'
import { traexRecord, traexText } from './traex-protocol'
import { readTraexChildHistories, traexChildHistoryBlock } from './traex-child-history'
import {
  subagentJournalBody,
  subagentJournalItemIdentity
} from '../native-chat/agent-session-journal/item-lifecycle/journal-subagent-item'

export function createTraexConversationHistoryImporter(
  context: Parameters<StructuredAgentRuntimeRegistration['createAdapter']>[0]
): NonNullable<StructuredAgentSessionAdapter['readConversationHistory']> {
  return async (input) => {
    const cwd = input.source?.workspaceCwd
    if (!cwd) {
      throw new Error('TRAE CLI history imports require the recorded workspace directory')
    }
    const launch = await resolveTraexReadLaunch(context, input.accountHome, cwd, {
      signal: input.signal
    })
    return runAgentModelCatalogSession(
      () => new TraexAppServerConnection(launch),
      async (connection) => {
        await connection.initialize()
        const thread = traexRecord(
          traexRecord(
            await connection.request('thread/read', {
              threadId: input.providerSessionId,
              includeTurns: false
            })
          ).thread
        )
        const path = traexText(thread.path)
        if (!path || (await realpath(path)) !== (await realpath(input.transcriptPath))) {
          throw new Error('TRAE CLI read a different conversation transcript')
        }
        await assertAdoptedSourceIdentity(
          input.source ?? { providerSessionId: input.providerSessionId, workspaceCwd: cwd },
          { sessionId: traexText(thread.id) ?? null, cwd: traexText(thread.cwd) ?? null },
          true,
          input.signal,
          'trae'
        )
        const check = () => input.signal?.throwIfAborted()
        const turns = await readTraexTurns(connection, input.providerSessionId, check)
        const retained = createNewestItemWindow(16 * 1024 * 1024)
        for (const turn of turns) {
          check()
          for (const mutation of projectTraexHistoryTurn({
            threadId: input.providerSessionId,
            sessionId: input.sessionId,
            turn,
            epoch: 'traex-import'
          })) {
            retained.push({
              ...mutation.linkage,
              identity: mutation.identity,
              body: boundLegacyImportBody(mutation.body, LEGACY_IMPORT_BLOCK_LIMITS),
              turnScope: mutation.turnScope,
              observedAt: (turn.startedAt ?? 0) * 1000,
              ownerFence: 0
            })
          }
        }
        const children = await readTraexChildHistories(
          connection,
          input.providerSessionId,
          turns,
          check
        )
        for (const child of children) {
          check()
          retained.push({
            identity: subagentJournalItemIdentity(child.threadId),
            body: subagentJournalBody(traexChildHistoryBlock(child, input.sessionId)),
            turnScope: { kind: 'thread' },
            ownerFence: 0
          })
          for (const turn of child.turns) {
            for (const mutation of projectTraexHistoryTurn({
              threadId: child.threadId,
              primaryThreadId: input.providerSessionId,
              sessionId: input.sessionId,
              turn,
              epoch: 'traex-import',
              producer: child.producer
            })) {
              retained.push({
                ...mutation.linkage,
                identity: mutation.identity,
                body: boundLegacyImportBody(mutation.body, LEGACY_IMPORT_BLOCK_LIMITS),
                turnScope: mutation.turnScope,
                observedAt: (turn.startedAt ?? 0) * 1000,
                ownerFence: 0
              })
            }
          }
        }
        const items = retained.items()
        const ids = new Set(items.map((item) => agentJournalItemKey(item.identity)))
        return {
          items: items.filter(
            (item) => item.turnScope?.kind !== 'turn' || ids.has(item.turnScope.turnItemId)
          ),
          sourceEmpty: turns.length === 0
        }
      },
      { label: 'trae', signal: input.signal, timeoutMs: 30_000 }
    )
  }
}
