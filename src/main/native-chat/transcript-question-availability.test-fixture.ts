import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JournalHostDatabase } from './agent-session-journal/journal-host-database'
import { messageQuestionsFor } from './message-question-repository'
import { installTranscriptWatcher } from './transcript-watch-engine'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { queryTranscriptCurrentQuestions } from './transcript-current-questions'
import { readCurrentRequestsPiece } from './agent-session-wire/agent-session-current-requests'
import { createNativeChatCurrentRequestsBinding } from '../../shared/native-chat-current-requests-binding'
import {
  currentMessageQuestionView,
  type AgentSessionCurrentRequestsState
} from '../../shared/agent-session-current-requests'

export async function terminalQuestionAvailabilityFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-terminal-question-client-'))
  const path = join(root, 'rollout.jsonl')
  const database = JournalHostDatabase.open(join(root, 'host'))
  const repository = messageQuestionsFor(database)
  let state: AgentSessionCurrentRequestsState = {}
  let available = false
  const question = (id: string) =>
    `${JSON.stringify({
      type: 'response_item',
      payload: {
        id,
        type: 'function_call',
        name: 'request_user_input_async',
        call_id: id,
        arguments: JSON.stringify({
          questions: [{ title: 'Independent async question?', options: ['Blue', 'Red'] }]
        })
      }
    })}\n`
  await writeFile(path, question('q1'))
  const binding = createNativeChatCurrentRequestsBinding({
    read: (request, signal) =>
      queryTranscriptCurrentQuestions(
        path,
        'codex',
        'terminal-source',
        decodeCodexTranscriptLine,
        (projection) => readCurrentRequestsPiece(projection, request),
        signal,
        repository
      ),
    publish: (next) => {
      state = next
    }
  })
  const watcher = await installTranscriptWatcher(path, decodeCodexTranscriptLine, {
    agent: 'codex',
    sessionId: 'terminal-source',
    initialLimit: 1,
    debounceMs: 1,
    reconciliationIntervalMs: 20,
    prepareCurrentRequests: async () => {
      if (!available) {
        throw new Error('Isolated question preparation failure')
      }
      return repository
    },
    onInitialSnapshot: () => {},
    onAppend: () => {},
    onCurrentRequests: (publication) =>
      binding.observe({ type: 'appended', currentRequests: publication.marker })
  })
  if (!watcher) {
    throw new Error('Expected real transcript watcher')
  }
  return {
    view: () => currentMessageQuestionView(state),
    state: () => state,
    enable: () => {
      available = true
    },
    failCreation: async () => {
      database.db.exec(
        "CREATE TEMP TRIGGER fail_client_async_creation BEFORE INSERT ON message_question_occurrences BEGIN SELECT RAISE(ABORT, 'isolated async creation failure'); END"
      )
      await appendFile(path, question('q2'))
    },
    restoreCreation: () => database.db.exec('DROP TRIGGER fail_client_async_creation'),
    close: async () => {
      binding.invalidate()
      watcher.unsubscribe()
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}
