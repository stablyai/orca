import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JournalHostDatabase } from './agent-session-journal/journal-host-database'
import { setStructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-host'
import { messageQuestionsFor } from './message-question-repository'

export function questionResourceLine(id: string, label = 'Blue'): string {
  return `${JSON.stringify({
    type: 'response_item',
    payload: {
      id,
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: id,
      arguments: JSON.stringify({ questions: [{ title: 'Which color?', options: [label, 'Red'] }] })
    }
  })}\n`
}

export async function questionResourceFixture(label?: string) {
  const root = await mkdtemp(join(tmpdir(), 'orca-question-resource-'))
  const path = join(root, 'rollout.jsonl')
  await writeFile(path, questionResourceLine('q1', label))
  const database = JournalHostDatabase.open(join(root, 'host'))
  const repository = messageQuestionsFor(database)
  // SAFETY: the actual resource reader uses only deps.journalDatabase; registry permits partial test hosts.
  setStructuredAgentSessionHost({
    deps: { journalDatabase: database }
  } as StructuredAgentSessionHost)
  return {
    path,
    repository,
    database,
    dispose: async () => {
      setStructuredAgentSessionHost(null)
      repository.deleteTranscriptSources('codex', path)
      database.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}
