import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as transcriptFs from '../../native-chat/wsl-transcript-fs-access'
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
