import { afterEach, expect, it } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forkHistoryConversation } from './history-conversation-fork'
import { writeCodexHistoryFixture } from '../../native-chat/agent-session-journal/history-import/codex-history-test-fixture'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('forks Claude through its native materializer and moves companion history under the new identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-history-fork-'))
  directories.push(root)
  const sourceHome = join(root, 'source')
  const targetHome = join(root, 'target')
  const historyRoot = join(sourceHome, 'projects')
  const sessionId = '00000000-0000-4000-8000-000000000201'
  const filePath = join(historyRoot, '-project', `${sessionId}.jsonl`)
  const subagents = join(historyRoot, '-project', sessionId, 'subagents')
  const files = join(sourceHome, 'file-history', sessionId)
  await Promise.all([subagents, files, targetHome].map((path) => mkdir(path, { recursive: true })))
  const original = `${[
    {
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000202',
      parentUuid: null,
      sessionId,
      cwd: '/project',
      timestamp: '2026-11-17T10:00:00.000Z',
      message: { role: 'user', content: 'Continue the original Claude work' }
    },
    {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000203',
      parentUuid: '00000000-0000-4000-8000-000000000202',
      sessionId,
      cwd: '/project',
      timestamp: '2026-11-17T10:01:00.000Z',
      message: {
        id: 'msg_answer',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [{ type: 'text', text: 'Original answer' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    }
  ]
    .map((row) => JSON.stringify(row))
    .join('\n')}\n`
  await writeFile(filePath, original)
  await writeFile(join(subagents, 'agent.jsonl'), 'subagent context')
  await writeFile(join(files, 'version'), 'original file version')
  await writeFile(join(targetHome, '.credentials.json'), 'target-login')
  const copy = await forkHistoryConversation({
    provider: 'claude',
    sessionId,
    filePath,
    sourceHome,
    historyRoot,
    targetHome
  })
  expect(copy.sessionId).not.toBe(sessionId)
  expect(await readFile(copy.filePath, 'utf8')).toContain('Continue the original Claude work')
  expect(
    await readFile(
      join(targetHome, 'projects', '-project', copy.sessionId, 'subagents', 'agent.jsonl'),
      'utf8'
    )
  ).toBe('subagent context')
  expect(await readFile(join(targetHome, 'file-history', copy.sessionId, 'version'), 'utf8')).toBe(
    'original file version'
  )
  await appendFile(copy.filePath, 'independent continuation\n')
  expect(await readFile(filePath, 'utf8')).toBe(original)
  expect(await readFile(join(targetHome, '.credentials.json'), 'utf8')).toBe('target-login')
})

it('flattens Codex ancestor history without losing native messages, context or independent writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-history-fork-'))
  directories.push(root)
  const historyRoot = join(root, 'source', 'sessions')
  await mkdir(historyRoot, { recursive: true })
  const parent = await writeCodexHistoryFixture(
    historyRoot,
    '00000000-0000-4000-8000-000000000101',
    ['Original question']
  )
  const child = await writeCodexHistoryFixture(
    historyRoot,
    '00000000-0000-4000-8000-000000000102',
    ['Follow-up question'],
    parent.position
  )
  await appendFile(
    child.filePath,
    `${JSON.stringify({ type: 'turn_context', ordinal: 10, payload: { cwd: '/project', model: 'gpt-5' } })}\n`
  )
  const original = await readFile(child.filePath, 'utf8')
  const copy = await forkHistoryConversation({
    provider: 'codex',
    sessionId: '00000000-0000-4000-8000-000000000102',
    filePath: child.filePath,
    sourceHome: join(root, 'source'),
    historyRoot,
    targetHome: join(root, 'target')
  })
  const records = (await readFile(copy.filePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(records[0]).toMatchObject({
    ordinal: 0,
    payload: { history_mode: 'paginated', forked_from_id: '00000000-0000-4000-8000-000000000102' }
  })
  expect(records[0].payload.history_base).toBeUndefined()
  expect(records.map((record) => record.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(
    records
      .filter((record) => record.type === 'response_item')
      .map((record) => record.payload.content[0].text)
  ).toEqual([
    'Original question',
    'Original question answer',
    'Follow-up question',
    'Follow-up question answer'
  ])
  expect(records[9]).toMatchObject({
    type: 'turn_context',
    payload: { cwd: '/project', model: 'gpt-5' }
  })
  expect(records[2].payload.thread_id).toBe(copy.sessionId)
  await appendFile(copy.filePath, 'independent continuation\n')
  expect(await readFile(child.filePath, 'utf8')).toBe(original)
})
