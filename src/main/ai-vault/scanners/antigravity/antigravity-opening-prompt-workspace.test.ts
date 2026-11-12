import { describe, expect, it } from 'vitest'
import { createAntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import {
  createAntigravitySessionResumeState,
  parseAntigravitySessionContent
} from './session-scanner-antigravity-parser'
import { jsonLines } from '../../session-scanner-test-fixtures'

const openingTime = '2026-07-15T11:39:10.000Z'
const historyPath = '/home/ada/.gemini/antigravity-cli/history.jsonl'
const file = {
  path: '/home/ada/.gemini/antigravity-cli/brain/brain-id/.system_generated/logs/transcript.jsonl',
  mtimeMs: Date.parse(openingTime),
  modifiedAt: openingTime
}

function user(prompt: string, timestamp: string | null = openingTime) {
  return {
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    created_at: timestamp,
    content: `<USER_REQUEST>${prompt}</USER_REQUEST>`
  }
}

function openingRecords(prompt: string, timestamp: string | null = openingTime) {
  return [
    {
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      created_at: '2026-07-15T11:38:00.000Z',
      content: 'Earlier system metadata is not the first prompt timestamp'
    },
    user(prompt, timestamp),
    ...Array.from({ length: 7 }, (_, index) =>
      user(`Later request ${index}`, `2026-07-15T11:4${index}:10.000Z`)
    )
  ]
}

function historyRow(display: string, workspace = '/repo/original', conversationId?: string) {
  return { display, workspace, timestamp: Date.parse(openingTime) / 1000, conversationId }
}

function resolver(rows: ReturnType<typeof historyRow>[]) {
  return createAntigravityWorkspaceResolver(async (path) =>
    path === historyPath ? jsonLines(rows) : null
  )
}

async function parse(prompt: string, timestamp: string | null = openingTime) {
  const session = await parseAntigravitySessionContent(
    file,
    jsonLines(openingRecords(prompt, timestamp)),
    'linux'
  )
  if (!session) {
    throw new Error('Missing parsed fixture session')
  }
  expect(session.previewMessagesTruncated).toBe(true)
  expect(session.previewMessages.every((message) => message.text !== prompt)).toBe(true)
  expect(session.firstUserPrompt).toBeUndefined()
  return session
}

describe('Antigravity opening prompt workspace association', () => {
  it.each([undefined, 'history-id'])(
    'retains a long session workspace with row id %s',
    async (id) => {
      const prompt = 'Locate the original workspace'
      const session = await parse(prompt)
      expect(session.createdAt).not.toBe(openingTime)
      expect(
        (await resolver([historyRow(prompt, '/repo/original', id)]).enrich(session, historyPath))
          .cwd
      ).toBe('/repo/original')
    }
  )

  it('keeps the opening association across incremental clones and preview shifts', async () => {
    const prompt = 'Original incremental request'
    const state = createAntigravitySessionResumeState(file)
    state.consumeLine(JSON.stringify(user(prompt)))
    const clone = state.clone()
    for (const record of openingRecords('Unrelated later prompt')) {
      clone.consumeLine(JSON.stringify(record))
    }
    const session = await clone.finalize('linux')
    if (!session) {
      throw new Error('Missing cloned session')
    }
    expect(session.previewMessagesTruncated).toBe(true)
    expect((await resolver([historyRow(prompt)]).enrich(session, historyPath)).cwd).toBe(
      '/repo/original'
    )
    expect((await state.finalize('linux'))?.previewMessages).toHaveLength(1)
  })
})
