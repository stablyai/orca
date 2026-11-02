import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import { kimiSessionContentFingerprint } from './session-scanner-kimi-content-fingerprint'
import { parseKimiSessionFile } from './session-scanner-kimi-parser'
import type { TranscriptMessage } from './session-transcript-consumers'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('does not read child wires that legacy Kimi parsing ignores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kimi-legacy-wires-'))
  roots.push(root)
  const session = join(root, 'sessions', 'wd_fixture', 'session_v1-fixture')
  const main = join(session, 'agents', 'main', 'wire.jsonl')
  const child = join(session, 'agents', 'agent-1', 'wire.jsonl')
  await mkdir(join(session, 'agents', 'main'), { recursive: true })
  await mkdir(join(session, 'agents', 'agent-1'), { recursive: true })
  const path = join(session, 'state.json')
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      agents: { main: { type: 'main' }, 'agent-1': { type: 'subagent' } }
    })
  )
  await writeFile(
    main,
    JSON.stringify({
      type: 'context.append_message',
      message: { role: 'user', origin: { kind: 'user' }, content: 'legacy question' }
    })
  )
  await writeFile(child, 'unused child transcript')
  const open = vi.spyOn(transcriptFs, 'openTranscriptReadStream')
  const result = await parseKimiSessionFile(
    { path, mtimeMs: 1, modifiedAt: '2026-10-04T14:00:00.000Z' },
    'darwin'
  )
  expect(result?.previewMessages.map((message) => message.text)).toContain('legacy question')
  expect(open.mock.calls.map(([wire]) => wire)).toEqual([main])
  const stat = vi.spyOn(transcriptFs, 'wslGatedStat')
  await kimiSessionContentFingerprint(path)
  expect(stat.mock.calls.map(([wire]) => wire)).toEqual([main])
})

it.each(['milliseconds', 'iso'])(
  'normalizes Kimi v2 %s state timestamps and retains cwd without an index',
  async (format) => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-v2-'))
    roots.push(root)
    const session = join(root, 'sessions', 'wd_fixture', 'session_v2-fixture')
    await mkdir(join(session, 'agents', 'main'), { recursive: true })
    const path = join(session, 'state.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        cwd: '/synthetic/kimi-app',
        createdAt:
          format === 'iso' ? '2026-10-04T13:30:00.000Z' : Date.parse('2026-10-04T13:30:00.000Z'),
        updatedAt:
          format === 'iso' ? '2026-10-04T14:00:00.000Z' : Date.parse('2026-10-04T14:00:00.000Z'),
        agents: { main: { type: 'main' } }
      })
    )
    await writeFile(join(session, 'agents', 'main', 'wire.jsonl'), '')
    const result = await parseKimiSessionFile(
      { path, mtimeMs: 1, modifiedAt: '2026-10-04T14:00:00.000Z' },
      'darwin'
    )
    expect(result?.createdAt).toBe('2026-10-04T13:30:00.000Z')
    expect(result?.updatedAt).toBe('2026-10-04T14:00:00.000Z')
    expect(result?.cwd).toBe('/synthetic/kimi-app')
  }
)

it('publishes v2 canonical turns and tool calls/results once, with record timestamps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kimi-v2-'))
  roots.push(root)
  const session = join(root, 'sessions', 'wd_fixture', 'session_v2-fixture')
  await mkdir(join(session, 'agents', 'main'), { recursive: true })
  const path = join(session, 'state.json')
  await writeFile(path, JSON.stringify({ version: 2, agents: { main: { type: 'main' } } }))
  const time = Date.parse('2026-10-04T13:30:00.000Z')
  const appended = (message: unknown) => ({
    type: 'agent.message.appended',
    time,
    message: { message, meta: { origin: { kind: 'user' } } }
  })
  const loop = (event: unknown) => ({ type: 'context.append_loop_event', time, event })
  const records = [
    {
      type: 'context.append_message',
      time,
      message: {
        role: 'user',
        origin: { kind: 'user' },
        content: [{ type: 'text', text: 'beta11 fixture user' }]
      }
    },
    appended({ role: 'user', content: [{ type: 'text', text: 'beta11 fixture user' }] }),
    loop({ type: 'content.part', part: { type: 'text', text: 'fixture answer' } }),
    loop({
      type: 'tool.call',
      toolCallId: 'call-1',
      name: 'Bash',
      args: { command: 'printf fixture-command' }
    }),
    appended({
      role: 'assistant',
      content: [{ type: 'text', text: 'fixture answer' }],
      toolCalls: [{ id: 'call-1', name: 'Bash', arguments: '{"command":"printf fixture-command"}' }]
    }),
    loop({
      type: 'tool.result',
      toolCallId: 'call-1',
      result: { output: 'ElementResolutionError fixture-output' }
    }),
    appended({
      role: 'tool',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'ElementResolutionError fixture-output' }]
    }),
    loop({ type: 'step.end' })
  ]
  await writeFile(
    join(session, 'agents', 'main', 'wire.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n')
  )
  const messages: TranscriptMessage[] = []
  await parseKimiSessionFile(
    { path, mtimeMs: 1, modifiedAt: '2026-10-04T14:00:00.000Z' },
    'darwin',
    { active: true, push: (m) => messages.push(m) }
  )
  expect(messages.filter((m) => m.role === 'user')).toEqual([
    { role: 'user', text: 'beta11 fixture user', timestamp: '2026-10-04T13:30:00.000Z' }
  ])
  expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
  expect(messages.filter((m) => m.role === 'tool').map((m) => m.text)).toEqual([
    'Bash: printf fixture-command',
    'ElementResolutionError fixture-output'
  ])
  expect(messages.every((m) => m.timestamp === '2026-10-04T13:30:00.000Z')).toBe(true)
})

it('retains v2 user and assistant messages when only context stream events are present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kimi-v2-stream-'))
  roots.push(root)
  const session = join(root, 'sessions', 'wd_fixture', 'session_v2-fixture')
  await mkdir(join(session, 'agents', 'main'), { recursive: true })
  const path = join(session, 'state.json')
  await writeFile(path, JSON.stringify({ version: 2, agents: { main: { type: 'main' } } }))
  const time = Date.parse('2026-10-04T13:30:00.000Z')
  const records = [
    {
      type: 'context.append_message',
      time,
      message: {
        role: 'user',
        origin: { kind: 'user' },
        content: 'stream-only question'
      }
    },
    {
      type: 'context.append_loop_event',
      time,
      event: {
        type: 'content.part',
        part: { type: 'text', text: 'stream-only answer' }
      }
    },
    { type: 'context.append_loop_event', time, event: { type: 'step.end' } }
  ]
  await writeFile(
    join(session, 'agents', 'main', 'wire.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n')
  )
  const messages: TranscriptMessage[] = []
  await parseKimiSessionFile(
    { path, mtimeMs: 1, modifiedAt: '2026-10-04T14:00:00.000Z' },
    'darwin',
    { active: true, push: (message) => messages.push(message) }
  )
  expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
    { role: 'user', text: 'stream-only question' },
    { role: 'assistant', text: 'stream-only answer' }
  ])
})

it('deduplicates mirrors with different timestamps without dropping repeated turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kimi-v2-mirrors-'))
  roots.push(root)
  const session = join(root, 'sessions', 'wd_fixture', 'session_v2-fixture')
  await mkdir(join(session, 'agents', 'main'), { recursive: true })
  const path = join(session, 'state.json')
  await writeFile(path, JSON.stringify({ version: 2, agents: { main: { type: 'main' } } }))
  const time = Date.parse('2026-10-04T13:30:00.000Z')
  const turn = (at: number) => [
    {
      type: 'context.append_message',
      time: at,
      message: {
        role: 'user',
        origin: { kind: 'user' },
        content: 'repeat'
      }
    },
    {
      type: 'agent.message.appended',
      time: at + 1,
      message: {
        message: { role: 'user', content: 'repeat' },
        meta: {}
      }
    },
    {
      type: 'context.append_loop_event',
      time: at + 2,
      event: {
        type: 'content.part',
        part: { type: 'text', text: 'answer' }
      }
    },
    {
      type: 'agent.message.appended',
      time: at + 3,
      message: {
        message: { role: 'assistant', content: 'answer' },
        meta: {}
      }
    },
    { type: 'context.append_loop_event', time: at + 4, event: { type: 'step.end' } }
  ]
  await writeFile(
    join(session, 'agents', 'main', 'wire.jsonl'),
    [...turn(time), ...turn(time + 1000)].map((record) => JSON.stringify(record)).join('\n')
  )
  const messages: TranscriptMessage[] = []
  await parseKimiSessionFile(
    { path, mtimeMs: 1, modifiedAt: '2026-10-04T14:00:00.000Z' },
    'darwin',
    { active: true, push: (message) => messages.push(message) }
  )
  expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
    { role: 'user', text: 'repeat' },
    { role: 'assistant', text: 'answer' },
    { role: 'user', text: 'repeat' },
    { role: 'assistant', text: 'answer' }
  ])
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'rejects an unreadable v2 wire instead of committing a partial searchable session',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-v2-'))
    roots.push(root)
    const session = join(root, 'sessions', 'wd_fixture', 'session_v2-fixture')
    await mkdir(join(session, 'agents', 'main'), { recursive: true })
    const path = join(session, 'state.json')
    const wire = join(session, 'agents', 'main', 'wire.jsonl')
    await writeFile(path, JSON.stringify({ version: 2, agents: { main: { type: 'main' } } }))
    await writeFile(wire, '{}\n')
    await chmod(wire, 0)
    try {
      await expect(
        parseKimiSessionFile({ path, mtimeMs: 1, modifiedAt: '2026-10-04T14:00:00.000Z' }, 'darwin')
      ).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(wire, 0o600)
    }
  }
)
