import './claude-conversation-worker.test-fixture'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { copyClaudeConversation } from './claude-conversation-copy'
import { materializeClaudeRewindTranscript } from './claude-rewind-transcript'

const accounts = vi.hoisted((): { homes: string[] } => ({ homes: [] }))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => ({
    accountHomes: () => accounts.homes,
    systemDefaultHome: () => accounts.homes[0]
  })
}))
const SOURCE = '00000000-0000-4000-8000-000000000001'
let root: string
let oldHome: string
let selectedHome: string
let sourcePath: string
function parseRows(source: string) {
  return source
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}
let rows: ReturnType<typeof parseRows>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-fork-claude-'))
  oldHome = join(root, 'old')
  selectedHome = join(root, 'selected')
  accounts.homes = [oldHome]
  const project = join(oldHome, 'projects', 'workspace')
  await mkdir(project, { recursive: true })
  sourcePath = join(project, `${SOURCE}.jsonl`)
  const source = await readFile(
    new URL('./__fixtures__/claude-rewind-hook.jsonl', import.meta.url),
    'utf8'
  )
  rows = parseRows(source)
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

function copy(
  uuid: string,
  settled: boolean,
  before?: string,
  opener?: string,
  source = SOURCE,
  destinationCwd?: string
) {
  return copyClaudeConversation({
    ...(destinationCwd ? { destinationCwd } : {}),
    identity: {
      sessionId: 'orca-source',
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'claude',
      providerHandle: null
    },
    providerSessionId: source,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: selectedHome },
    title: 'Source fork',
    checkpoint: {
      selectedItemId: uuid,
      settled,
      throughMessage: { sessionId: source, uuid },
      ...(opener ? { rootMessage: { sessionId: source, uuid: opener } } : {}),
      ...(before ? { beforeMessage: { sessionId: source, uuid: before } } : {})
    }
  })
}

it('reads the source account and writes the independent copy to the selected home, including the terminal tool result', async () => {
  const prefix = rows.slice(0, 28)
  const original = `${prefix.map((row) => JSON.stringify(row)).join('\n')}\n`
  await writeFile(sourcePath, original)
  const assistant = prefix.findLast((row) => row.type === 'assistant')!
  const result = await copy(assistant.uuid, true)
  expect(result.filePath).toBe(
    join(selectedHome, 'projects', 'workspace', `${result.sessionId}.jsonl`)
  )
  const copied = (await readFile(result.filePath!, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const messages = copied.filter((row) => row.type === 'assistant' || row.type === 'user')
  expect(messages.at(-1)).toMatchObject({
    type: 'user',
    forkedFrom: { messageUuid: 'a33ccffb-9cd3-54dc-bd5c-bad5de38fdd7' }
  })
  expect(result.coverage).toEqual({
    unit: 'claude-entry',
    ids: copied
      .filter(
        (row) =>
          ['user', 'assistant', 'attachment'].includes(row.type) ||
          (row.type === 'system' && typeof row.parentUuid === 'string')
      )
      .map((row) => row.uuid)
  })
  expect(result.resumeCursor).toBe(messages.at(-1)?.uuid)
  expect(await readFile(sourcePath, 'utf8')).toBe(original)
  expect(await readdir(join(oldHome, 'projects', 'workspace'))).toEqual([`${SOURCE}.jsonl`])
})

it('accepts a native terminal assistant without a duration row but refuses unresolved tool work', async () => {
  const assistantIndex = rows.findLastIndex((row) => row.type === 'assistant')
  const prefix = rows.slice(0, assistantIndex + 1)
  const last = prefix.at(-1)!
  last.message.stop_reason = 'end_turn'
  last.message.content = [{ type: 'text', text: 'Finished response' }]
  await writeFile(sourcePath, `${prefix.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const copyResult = await copy(last.uuid, false)
  expect(copyResult.sessionId).not.toBe(SOURCE)
  last.message.stop_reason = 'tool_use'
  last.message.content = [{ type: 'tool_use', id: 'call', name: 'Read', input: {} }]
  await writeFile(sourcePath, `${prefix.map((row) => JSON.stringify(row)).join('\n')}\n`)
  await expect(copy(last.uuid, false)).rejects.toThrow("Claude hasn't finished this response yet")
})

it('uses the settled native root when the streamed final frame was lost after a recorded tool result', async () => {
  await writeFile(
    sourcePath,
    `${rows
      .slice(0, 25)
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  )
  const result = await copy(
    'block:msg_lost_final:0',
    true,
    undefined,
    '4eb1bf4d-de83-5a3a-be2b-0b877f1b1540'
  )
  const copied = parseRows(await readFile(result.filePath!, 'utf8'))
  expect(copied.findLast((row) => row.type === 'user')).toMatchObject({
    forkedFrom: { messageUuid: 'a33ccffb-9cd3-54dc-bd5c-bad5de38fdd7' }
  })
})

it('retains an accepted queued steer at the interrupted main-branch endpoint', async () => {
  const prefix = rows.slice(0, 25)
  prefix.push({
    type: 'attachment',
    uuid: '00000000-0000-4000-8000-000000000099',
    parentUuid: 'a33ccffb-9cd3-54dc-bd5c-bad5de38fdd7',
    sessionId: SOURCE,
    attachment: {
      type: 'queued_command',
      commandMode: 'prompt',
      origin: { kind: 'human' },
      humanTurn: true,
      prompt: 'Also remember B'
    }
  })
  await writeFile(sourcePath, `${prefix.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const result = await copy('90aca715-6ef8-59b8-aced-da70744cd0bd', true)
  const copied = parseRows(await readFile(result.filePath!, 'utf8'))
  expect(copied.findLast((row) => row.type === 'attachment')).toMatchObject({
    attachment: { prompt: 'Also remember B' },
    forkedFrom: { messageUuid: '00000000-0000-4000-8000-000000000099' }
  })
})

it('resolves an early response beyond the catch-up suffix budget', async () => {
  const prefix = rows.slice(0, 25)
  prefix[24].message.content[0].content = 'saved tool output '.repeat(1_000_000)
  await writeFile(sourcePath, `${prefix.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const result = await copy('90aca715-6ef8-59b8-aced-da70744cd0bd', true)
  const copied = parseRows(await readFile(result.filePath!, 'utf8'))
  expect(copied.findLast((row) => row.type === 'user')).toMatchObject({
    forkedFrom: { messageUuid: 'a33ccffb-9cd3-54dc-bd5c-bad5de38fdd7' }
  })
})

it.each(['fork', 'rewind'] as const)(
  'forks inherited responses from real SDK %s output ending in custom-title',
  async (origin) => {
    const prefix = rows.slice(0, 52)
    await writeFile(sourcePath, `${prefix.map((row) => JSON.stringify(row)).join('\n')}\n`)
    const last = prefix.findLast((row) => row.type === 'assistant')!
    const first =
      origin === 'fork'
        ? await copy(last.uuid, true)
        : await materializeClaudeRewindTranscript(
            sourcePath,
            {
              sessionId: 'rewind-child',
              sourceSessionId: SOURCE,
              throughEntryId: rows[50].uuid,
              replacesSessionId: SOURCE
            },
            join(selectedHome, 'projects', 'workspace')
          )
    const copied = parseRows(
      await readFile(
        join(selectedHome, 'projects', 'workspace', `${first.sessionId}.jsonl`),
        'utf8'
      )
    )
    expect(copied.at(-1)).toMatchObject({ type: 'custom-title' })
    expect(copied.at(-1)?.parentUuid).toBeUndefined()
    const reply = copied.findLast((row) => row.type === 'assistant')!
    const second = await copy(reply.uuid, true, undefined, undefined, first.sessionId)
    const secondRows = parseRows(await readFile(second.filePath!, 'utf8'))
    expect(secondRows.findLast((row) => row.type === 'assistant')).toMatchObject({
      forkedFrom: { sessionId: first.sessionId, messageUuid: reply.uuid }
    })
    const nextPrompt = copied.find((row) => row.forkedFrom?.messageUuid === rows[34].uuid)!
    const earlierReply = copied.find((row) => row.type === 'assistant')!
    const bounded = await copy(earlierReply.uuid, true, nextPrompt.uuid, undefined, first.sessionId)
    const boundedRows = parseRows(await readFile(bounded.filePath!, 'utf8'))
    expect(boundedRows.some((row) => row.forkedFrom?.messageUuid === nextPrompt.uuid)).toBe(false)
    expect(boundedRows.findLast((row) => row.type === 'user')).toMatchObject({
      forkedFrom: {
        messageUuid: copied.find((row) => row.forkedFrom?.messageUuid === rows[26].uuid)!.uuid
      }
    })
  }
)

it("writes a copy for another worktree into that worktree's project, where Claude resumes it", async () => {
  const prefix = rows.slice(0, 28)
  await writeFile(sourcePath, `${prefix.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const assistant = prefix.findLast((row) => row.type === 'assistant')!
  const result = await copy(
    assistant.uuid,
    true,
    undefined,
    undefined,
    SOURCE,
    '/repo/feature.fork'
  )
  expect(result.filePath).toBe(
    join(selectedHome, 'projects', '-repo-feature-fork', `${result.sessionId}.jsonl`)
  )
  expect(await readdir(join(selectedHome, 'projects'))).toEqual(['-repo-feature-fork'])
})

it('refuses a worktree whose path Claude would name by hash, writing nothing', async () => {
  const prefix = rows.slice(0, 28)
  await writeFile(sourcePath, `${prefix.map((row) => JSON.stringify(row)).join('\n')}\n`)
  const assistant = prefix.findLast((row) => row.type === 'assistant')!
  await expect(
    copy(assistant.uuid, true, undefined, undefined, SOURCE, `/${'a'.repeat(250)}`)
  ).rejects.toThrow('Use a shorter worktree path')
  await expect(readdir(join(selectedHome, 'projects'))).rejects.toThrow()
})
