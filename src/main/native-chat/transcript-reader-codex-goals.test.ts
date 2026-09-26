import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readNativeChatTranscript } from './transcript-reader'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { stripNoiseMessages } from '../../shared/native-chat-noise'

const fixture = await readFile(
  new URL('./fixtures/codex-0.155.1-goal.jsonl', import.meta.url),
  'utf8'
)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function transcript(text = fixture): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-goal-folder-'))
  roots.push(root)
  const filePath = join(root, 'rollout.jsonl')
  await writeFile(filePath, text)
  return filePath
}

it('reopens the captured 0.155.1 goal before the first assistant without a user reinjection', async () => {
  const filePath = await transcript()
  const full = await readNativeChatTranscript('codex', 'fixture', { filePath })
  const tail = await readNativeChatTranscriptTail({
    agent: 'codex',
    sessionId: 'fixture',
    filePath,
    limit: 50
  })
  expect(full).toMatchObject({
    messages: [
      {
        role: 'system',
        blocks: [{ type: 'text', text: 'Goal set: Keep the scratch folder tidy.' }]
      },
      { role: 'assistant', id: 'fixture-assistant' }
    ]
  })
  expect('messages' in full && full.messages).toHaveLength(2)
  expect(tail).toMatchObject(full)
})

it('retains the goal when pagination reaches the first record', async () => {
  const filePath = await transcript()
  const newest = await readNativeChatTranscriptTail({
    agent: 'codex',
    sessionId: 'fixture',
    filePath,
    limit: 1
  })
  expect(newest).toMatchObject({ messages: [{ id: 'fixture-assistant' }], hasMore: true })
  if (!('messages' in newest)) {
    throw new Error(newest.error)
  }
  const previous = await readNativeChatTranscriptTail({
    agent: 'codex',
    sessionId: 'fixture',
    filePath,
    limit: 1,
    beforeOffset: newest.beforeOffset
  })
  expect(previous).toMatchObject({ messages: [{ role: 'system' }], hasMore: false })
  if (!('messages' in previous)) {
    throw new Error(previous.error)
  }
  expect(stripNoiseMessages([...previous.messages, ...newest.messages])).toHaveLength(2)
})

it('collapses accounting snapshots across pages while preserving transitions and new goals', async () => {
  const first = fixture.split('\n')[2]
  if (!first) {
    throw new Error('Captured goal missing')
  }
  const captured = JSON.parse(first)
  const goal = (status: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      ...captured,
      payload: { ...captured.payload, goal: { ...captured.payload.goal, status, ...extra } }
    })
  const filePath = await transcript(
    `${[
      goal('active'),
      goal('active', { tokensUsed: 12 }),
      fixture.split('\n')[4],
      goal('active', { tokensUsed: 30, tokenBudget: 4000 }),
      goal('paused'),
      goal('active'),
      goal('complete'),
      goal('active', { createdAt: 1790073999 }),
      goal('active', { createdAt: 1790074999 }),
      goal('futureStatus')
    ].join('\n')}\n`
  )
  const full = await readNativeChatTranscript('codex', 'fixture', { filePath })
  if (!('messages' in full)) {
    throw new Error(full.error)
  }
  const expected = [
    'Goal set',
    'Goal paused',
    'Goal set',
    'Goal complete',
    'Goal set',
    'Goal set',
    'Goal updated'
  ]
  const projected = stripNoiseMessages(full.messages)
  expect(
    projected.filter((message) => message.role === 'system').map((message) => message.blocks[0])
  ).toEqual(
    expected.map((prefix) => ({ type: 'text', text: `${prefix}: Keep the scratch folder tidy.` }))
  )
  const pages: NativeChatMessage[] = []
  let beforeOffset: number | undefined
  for (;;) {
    const page = await readNativeChatTranscriptTail({
      agent: 'codex',
      sessionId: 'fixture',
      filePath,
      limit: 2,
      beforeOffset
    })
    if (!('messages' in page)) {
      throw new Error(page.error)
    }
    pages.unshift(...page.messages)
    if (!page.hasMore) {
      break
    }
    beforeOffset = page.beforeOffset
  }
  expect(stripNoiseMessages(pages)).toEqual(projected)
})

it('hides goal-context user reinjections in every supported message encoding', async () => {
  const text =
    '<codex_internal_context source="goal">Internal continuation</codex_internal_context>'
  const filePath = await transcript(
    `${[
      { type: 'event_msg', payload: { type: 'user_message', message: text } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] }
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'UserMessage',
            content: [
              { type: 'text', text },
              { type: 'text', text: 'Actual user prompt' }
            ]
          }
        }
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: '<custom_user_tag>keep this</custom_user_tag>' }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`
  )
  const result = await readNativeChatTranscript('codex', 'fixture', { filePath })
  expect(result).toMatchObject({
    messages: [
      { role: 'user', blocks: [{ type: 'text', text: 'Actual user prompt' }] },
      {
        role: 'user',
        blocks: [{ type: 'text', text: '<custom_user_tag>keep this</custom_user_tag>' }]
      }
    ]
  })
  expect('messages' in result && result.messages).toHaveLength(2)
})

it('preserves unobserved goal_context user markup', async () => {
  const text = '<goal_context>user-authored XML</goal_context>'
  const filePath = await transcript(
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } })}\n`
  )
  const result = await readNativeChatTranscript('codex', 'fixture', { filePath })
  expect(result).toMatchObject({ messages: [{ role: 'user', blocks: [{ type: 'text', text }] }] })
})
