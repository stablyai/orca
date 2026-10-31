import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import { renameClaudeTranscript } from './claude-provider-session-rename'

let home: string
let conversation: string
let transcript: string
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'orca-claude-rename-'))
  conversation = randomUUID()
  const project = join(home, 'projects', 'workspace')
  await fs.mkdir(project, { recursive: true })
  transcript = join(project, `${conversation}.jsonl`)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true })
})

it.each([false, true])(
  'appends both native names after a torn tail (earlier agent-name=%s)',
  async (earlierName) => {
    const user = {
      type: 'user',
      uuid: randomUUID(),
      sessionId: conversation,
      message: { role: 'user', content: 'ship it' }
    }
    const oldName = earlierName
      ? `${JSON.stringify({ type: 'agent-name', agentName: 'Earlier native name', sessionId: conversation })}\n`
      : ''
    const prefix = `${JSON.stringify(user)}\n${oldName}{"type":"assistant","mess`
    await fs.writeFile(transcript, prefix)
    const otherAccount = join(home, 'other-account', 'projects', 'workspace')
    await fs.mkdir(otherAccount, { recursive: true })
    const otherTranscript = join(otherAccount, `${conversation}.jsonl`)
    await fs.writeFile(otherTranscript, 'another account\n')
    const source = join(home, 'projects', 'workspace', `${randomUUID()}.jsonl`)
    await fs.writeFile(source, 'unrelated source\n')
    const inventory = vi.spyOn(transcriptFs, 'wslGatedReaddir')
    const stat = vi.spyOn(transcriptFs, 'wslGatedStat')
    const append = vi.spyOn(fs, 'appendFile')
    const originalOpen = fs.open
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      vi.spyOn(handle, 'read')
      return handle
    })
    await renameClaudeTranscript(home, conversation, ' Release notes ')
    const result = await fs.readFile(transcript, 'utf8')
    expect(result.slice(0, prefix.length + 1)).toBe(`${prefix}\n`)
    const lines = result
      .slice(prefix.length + 1)
      .trim()
      .split('\n')
    expect(lines).toHaveLength(2)
    const title = JSON.parse(lines[0] ?? '')
    expect(title).toMatchObject({
      type: 'custom-title',
      sessionId: conversation,
      customTitle: 'Release notes'
    })
    expect(title.uuid).toEqual(expect.any(String))
    expect(title.timestamp).toEqual(expect.any(String))
    expect(JSON.parse(lines[1] ?? '')).toEqual({
      type: 'agent-name',
      agentName: 'Release notes',
      sessionId: conversation
    })
    expect(inventory).toHaveBeenCalledTimes(1)
    expect(stat).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledExactlyOnceWith(transcript, 'r')
    const handle = await open.mock.results[0]?.value
    expect(handle?.read).toHaveBeenCalledExactlyOnceWith(
      expect.any(Buffer),
      0,
      1,
      Buffer.byteLength(prefix) - 1
    )
    expect(append).toHaveBeenCalledExactlyOnceWith(transcript, `\n${lines.join('\n')}\n`, {
      flag: 'a'
    })
    expect(await fs.readFile(otherTranscript, 'utf8')).toBe('another account\n')
    expect(await fs.readFile(source, 'utf8')).toBe('unrelated source\n')
    const listed = await listSessions({
      sessionStore: {
        load: async () => [user, title],
        append: async () => {},
        listSessions: async () => [{ sessionId: conversation, mtime: 1_700_000_000_000 }]
      }
    })
    expect(listed[0]?.customTitle).toBe('Release notes')
  }
)

it('refuses missing, empty, multiple and incomplete inventories without mutating another candidate', async () => {
  await expect(renameClaudeTranscript(home, conversation, 'Missing')).rejects.toThrow(
    'no transcript'
  )
  await fs.writeFile(transcript, '')
  await expect(renameClaudeTranscript(home, conversation, 'Empty')).rejects.toThrow('no transcript')
  await fs.writeFile(transcript, 'old\n')
  const second = join(home, 'projects', 'hash-or-worktree')
  await fs.mkdir(second)
  const duplicate = join(second, `${conversation}.jsonl`)
  await fs.writeFile(duplicate, 'other\n')
  await expect(renameClaudeTranscript(home, conversation, 'Ambiguous')).rejects.toThrow(
    'multiple transcripts'
  )
  expect(await fs.readFile(transcript, 'utf8')).toBe('old\n')
  expect(await fs.readFile(duplicate, 'utf8')).toBe('other\n')
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  vi.spyOn(transcriptFs, 'wslGatedStat').mockRejectedValue(denied)
  await expect(renameClaudeTranscript(home, conversation, 'Denied')).rejects.toBe(denied)
  expect(await fs.readFile(transcript, 'utf8')).toBe('old\n')
})

it.each([10, 100])(
  'bounds literal candidate discovery at %i projects regardless of transcript count',
  async (count) => {
    await fs.writeFile(transcript, 'old\n')
    for (let i = 0; i < count; i++) {
      const project = join(home, 'projects', `project-${i}`)
      await fs.mkdir(project)
      await Promise.all(
        Array.from({ length: 20 }, (_, j) => fs.writeFile(join(project, `history-${j}.jsonl`), ''))
      )
    }
    const readDirectory = vi.spyOn(transcriptFs, 'wslGatedReaddir')
    const stat = vi.spyOn(transcriptFs, 'wslGatedStat')
    await renameClaudeTranscript(home, conversation, 'Final')
    expect(readDirectory).toHaveBeenCalledTimes(1)
    expect(stat).toHaveBeenCalledTimes(count + 1)
    expect(new Set(stat.mock.calls.map(([path]) => path)).size).toBe(count + 1)
    expect(
      (await fs.readFile(transcript, 'utf8'))
        .trim()
        .split('\n')
        .slice(-2)
        .map((line) => JSON.parse(line))
    ).toEqual([
      expect.objectContaining({
        type: 'custom-title',
        customTitle: 'Final',
        sessionId: conversation
      }),
      { type: 'agent-name', agentName: 'Final', sessionId: conversation }
    ])
  }
)
