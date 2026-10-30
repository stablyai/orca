import { JournalHostDatabase } from './agent-session-journal/journal-host-database'
import { messageQuestionsFor } from './message-question-repository'
import type { CurrentRequestsProjection } from './agent-session-wire/agent-session-current-requests'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import type { NativeChatTranscriptSubscription } from './transcript-watch-contract'
import { subscribeNativeChatTranscript as subscribeTranscript } from './transcript-watch'

const subscriptions = new Set<NativeChatTranscriptSubscription>()
let tempRoots: string[] = []
const questionDatabases: JournalHostDatabase[] = []

async function subscribeNativeChatTranscript(...args: Parameters<typeof subscribeTranscript>) {
  const subscription = await subscribeTranscript(...args)
  subscriptions.add(subscription)
  return subscription
}

beforeEach(() => {
  tempRoots = []
})

afterEach(async () => {
  for (const subscription of subscriptions) {
    subscription.unsubscribe()
  }
  subscriptions.clear()
  for (const database of questionDatabases) {
    database.close()
  }
  questionDatabases.length = 0
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function tempFile(initial: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-watch-'))
  tempRoots.push(root)
  const filePath = join(root, 'rollout.jsonl')
  await writeFile(filePath, initial)
  return filePath
}

async function questionRepository() {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-watch-questions-'))
  tempRoots.push(root)
  const database = JournalHostDatabase.open(root)
  questionDatabases.push(database)
  return messageQuestionsFor(database)
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('keeps complete source questions outside the terminal tail and atomically replays source replacement', async () => {
  const line = (id: string | undefined, type: string, extra: object = {}) =>
    `${JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-01T10:00:00.000Z',
      payload: { ...(id ? { id } : {}), type, ...extra }
    })}\n`
  const ask = line(undefined, 'function_call', {
    name: 'request_user_input_async',
    arguments: JSON.stringify({ questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }] })
  })
  const filler = Array.from({ length: 80 }, (_, i) =>
    line(`output-${i}`, 'message', {
      role: 'assistant',
      content: [{ type: 'text', text: 'Working' }]
    })
  ).join('')
  const filePath = await tempFile(ask + filler)
  const repository = await questionRepository()
  let questions: CurrentRequestsProjection | undefined
  let tail: NativeChatMessage[] = []
  const sub = await subscribeNativeChatTranscript({
    agent: 'codex',
    sessionId: 'async-source',
    prepareCurrentRequests: async () => repository,
    filePath,
    initialLimit: 1,
    onInitialSnapshot: (messages) => {
      tail = messages
    },
    onAppend: () => {},
    onCurrentRequests: (projection) => {
      questions = projection
    },
    debounceMs: 5,
    reconciliationIntervalMs: 20
  })
  await waitFor(() => questions !== undefined && tail.length === 1)
  const payload = () => {
    const value = questions?.items
    if (!value || Array.isArray(value)) {
      throw new Error('expected complete source projection')
    }
    return value
  }
  expect(tail[0].id).toBe('output-79')
  const sourceId = payload().asyncQuestions[0].sourceRowId
  expect(sourceId).toContain(filePath)
  expect(sourceId).not.toMatch(/^line-/)
  await appendFile(
    filePath,
    line('more', 'message', { role: 'assistant', content: [{ type: 'text', text: 'Continuing' }] })
  )
  await waitFor(() => payload().asyncQuestions[0].sourceRowId === sourceId)
  await appendFile(
    filePath,
    line('answer', 'message', { role: 'user', content: [{ type: 'text', text: 'Blue' }] })
  )
  await waitFor(() => payload().asyncQuestions.length === 0)
  await writeFile(filePath, ask)
  await waitFor(() => payload().asyncQuestions.length === 1)
  const old = questions?.marker.version
  const changed = ask.replace('Which color?', 'Which shade?')
  expect(changed.length).toBe(ask.length)
  await writeFile(filePath, changed)
  await waitFor(() => questions?.marker.version !== old)
  expect(payload().asyncQuestions[0].questions[0].question).toBe('Which shade?')
  sub.unsubscribe()
  const retired = questions
  await appendFile(filePath, ask)
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(questions).toBe(retired)
})

import { installTranscriptWatcher } from './transcript-watch-engine'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'

it.each([40, 400])(
  'shares one linear question replay for %i source rows and only decodes appended records afterward',
  async (count) => {
    const line = (id: number) =>
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: `m-${id}`,
          content: [{ type: 'text', text: 'Working' }]
        }
      })}\n`
    const filePath = await tempFile(Array.from({ length: count }, (_, i) => line(i)).join(''))
    let decoded = 0
    const decode = (line: string, fallbackId: string) => {
      decoded++
      return decodeCodexTranscriptLine(line, fallbackId)
    }
    const repository = await questionRepository()
    let projections = 0
    let snapshots = 0
    let appends = 0
    for (let viewer = 0; viewer < 2; viewer++) {
      const subscription = await installTranscriptWatcher(filePath, decode, {
        agent: 'codex',
        sessionId: `perf-${count}`,
        prepareCurrentRequests: async () => repository,
        initialLimit: 1,
        debounceMs: 5,
        reconciliationIntervalMs: 20,
        onInitialSnapshot: () => {
          snapshots++
        },
        onAppend: () => {
          appends++
        },
        onCurrentRequests: () => {
          projections++
        }
      })
      if (subscription) {
        subscriptions.add(subscription)
      }
    }
    await waitFor(() => snapshots === 2 && projections === 2)
    expect(decoded).toBeLessThanOrEqual(count + 4)
    const initial = decoded
    await appendFile(filePath, line(count))
    await waitFor(() => appends === 2)
    expect(decoded - initial).toBeLessThanOrEqual(4)
    expect(projections).toBe(2)
  }
)
