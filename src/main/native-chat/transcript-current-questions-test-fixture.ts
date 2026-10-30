import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, vi } from 'vitest'
import { JournalHostDatabase } from './agent-session-journal/journal-host-database'
import { messageQuestionsFor } from './message-question-repository'

export const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const release of cleanup.toReversed()) {
    await release()
  }
  cleanup.length = 0
})
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-question-source-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const database = JournalHostDatabase.open(join(root, 'host'))
  const fixture = {
    path: join(root, 'rollout.jsonl'),
    repository: messageQuestionsFor(database),
    database
  }
  cleanup.push(() => fixture.database.close())
  return fixture
}
export function question(id: string, detail = 'A choice', positional = false) {
  return `${JSON.stringify({
    type: 'response_item',
    payload: {
      ...(positional ? {} : { id }),
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: id,
      arguments: JSON.stringify({
        questions: [{ title: 'Which color?', options: [detail, 'Red'] }]
      })
    }
  })}\n`
}
export function output(id: string, role = 'assistant') {
  return `${JSON.stringify({
    type: 'response_item',
    payload: {
      id,
      type: 'message',
      role,
      content: [{ type: 'text', text: role === 'user' ? 'Blue' : 'Still working' }]
    }
  })}\n`
}
