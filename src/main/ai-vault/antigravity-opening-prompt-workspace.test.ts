import { describe, expect, it } from 'vitest'
import { createAntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import {
  createAntigravitySessionResumeState,
  parseAntigravitySessionContent
} from './session-scanner-antigravity-parser'
import { jsonLines } from './session-scanner-test-fixtures'

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

  it('refuses fallback when unrelated asks share a truncated opening title', async () => {
    const prefix = 'A long instruction shared by several unrelated projects '.repeat(3)
    const prompt = `${prefix}original task`
    const session = await parse(prompt)
    expect(session.title.endsWith('...')).toBe(true)
    const rows = [historyRow(`${prefix}other task`, '/repo/other'), historyRow(prompt)]
    expect((await resolver(rows).enrich(session, historyPath)).cwd).toBeNull()
  })

  it('normalizes opening whitespace consistently with history display', async () => {
    const session = await parse('Locate\n  the original workspace')
    expect(
      (await resolver([historyRow('Locate the original workspace')]).enrich(session, historyPath))
        .cwd
    ).toBe('/repo/original')
  })

  it('keeps the established title normalization of hidden opening context', async () => {
    const session = await parse('Locate the workspace<system-reminder>Hidden</system-reminder>')
    expect(session.title).toBe('Locate the workspace')
    expect(
      (await resolver([historyRow('Locate the workspace')]).enrich(session, historyPath)).cwd
    ).toBe('/repo/original')
  })

  it('refuses identical duplicate rows and keeps the two-second timestamp window', async () => {
    const prompt = 'Original request'
    const session = await parse(prompt)
    expect(
      (await resolver([historyRow(prompt), historyRow(prompt)]).enrich(session, historyPath)).cwd
    ).toBeNull()
    for (const [offset, expected] of [
      [2, '/repo/original'],
      [2.001, null]
    ] as const) {
      const row = historyRow(prompt)
      row.timestamp += offset
      expect((await resolver([row]).enrich(session, historyPath)).cwd).toBe(expected)
    }
  })

  it('leaves conflicting prompt/time matches unknown even when one row has an id', async () => {
    const prompt = 'Repeated request'
    const rows = [historyRow(prompt), historyRow(prompt, '/repo/other', 'other-id')]
    expect((await resolver(rows).enrich(await parse(prompt), historyPath)).cwd).toBeNull()
  })

  it('gives an exact id authority over a conflicting prompt match', async () => {
    const prompt = 'Repeated request'
    const rows = [historyRow(prompt), historyRow('Different display', '/repo/exact', 'brain-id')]
    expect((await resolver(rows).enrich(await parse(prompt), historyPath)).cwd).toBe('/repo/exact')
  })

  it('does not rescue conflicting exact ids through the prompt fallback', async () => {
    const prompt = 'Repeated request'
    const rows = [
      historyRow('One', '/repo/one', 'brain-id'),
      historyRow('Two', '/repo/two', 'brain-id'),
      historyRow(prompt)
    ]
    expect((await resolver(rows).enrich(await parse(prompt), historyPath)).cwd).toBeNull()
  })

  it('keeps ambiguous project metadata authoritative over history and prompt fallback', async () => {
    const prompt = 'Original request'
    const read = createAntigravityWorkspaceResolver(async (path) => {
      if (path === historyPath) {
        return jsonLines([historyRow(prompt, '/repo/history', 'brain-id')])
      }
      if (path.endsWith('projects.json')) {
        return JSON.stringify({ '/repo/one': 'project', '/repo/two': 'project' })
      }
      if (path.endsWith('conversation_metadata.json')) {
        return JSON.stringify({
          conversations: { 'brain-id': { summary: { ProjectID: 'project' } } }
        })
      }
      return null
    })
    expect((await read.enrich(await parse(prompt), historyPath)).cwd).toBeNull()
  })

  it('never joins a later preview turn or a title-only history row', async () => {
    const session = await parse('Opening request')
    const rows = [historyRow('Later request 3'), historyRow(session.title, '/repo/wrong')]
    rows[1].timestamp -= 60
    expect((await resolver(rows).enrich(session, historyPath)).cwd).toBeNull()
  })

  it.each([null, 'invalid timestamp'])(
    'does not substitute createdAt for opening time %s',
    async (time) => {
      const prompt = 'Opening request'
      const session = await parse(prompt, time)
      const row = historyRow(prompt)
      row.timestamp = Date.parse(session.createdAt ?? '') / 1000
      expect((await resolver([row]).enrich(session, historyPath)).cwd).toBeNull()
    }
  )

  it('does not let a later short prompt replace an oversized opening prompt', async () => {
    const session = await parse('x'.repeat(4097))
    expect(
      (await resolver([historyRow('Later request 3')]).enrich(session, historyPath)).cwd
    ).toBeNull()
  })

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
