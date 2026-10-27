import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { resolveClaudeRewindFork } from './claude-rewind-fork'

let root: string
let home: string
let project: string
let source: string
let path: string
let firstPrompt: string
let firstAnswer: string
let secondPrompt: string
let original: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-rewind-transcript-'))
  home = join(root, 'account')
  project = join(home, 'projects', 'workspace')
  await mkdir(project, { recursive: true })
  source = randomUUID()
  firstPrompt = randomUUID()
  firstAnswer = randomUUID()
  secondPrompt = randomUUID()
  path = join(project, `${source}.jsonl`)
  const entries = [
    {
      type: 'user',
      uuid: firstPrompt,
      parentUuid: null,
      message: { role: 'user', content: 'ALPHA' }
    },
    {
      type: 'assistant',
      uuid: firstAnswer,
      parentUuid: firstPrompt,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ALPHA' }] }
    },
    {
      type: 'user',
      uuid: secondPrompt,
      parentUuid: firstAnswer,
      message: { role: 'user', content: 'BRAVO' }
    }
  ]
    .map((entry) =>
      JSON.stringify({
        ...entry,
        sessionId: source,
        timestamp: '2026-10-20T00:00:00.000Z',
        isSidechain: false
      })
    )
    .join('\n')
  original = `${entries}\n`
  await writeFile(path, original)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function forkBefore(uuid: string) {
  return resolveClaudeRewindFork({
    orcaSessionId: 'orca-chat',
    rewindOperationId: randomUUID(),
    head: claudeProviderHandle(source, secondPrompt),
    prompt: { sessionId: source, uuid },
    claudeConfigDirs: [join(root, 'other-account'), home]
  })
}

describe('durable Claude rewind transcripts', () => {
  it('saves only kept context in its source account before the next send', async () => {
    const fork = await forkBefore(secondPrompt)
    expect(fork).toMatchObject({
      materialized: true,
      sourceSessionId: source,
      throughEntryId: firstAnswer
    })
    if (!fork) {
      throw new Error('fork missing')
    }
    const forkPath = join(project, `${fork.sessionId}.jsonl`)
    const contents = await readFile(forkPath, 'utf8')
    expect(contents).toContain('ALPHA')
    expect(contents).not.toContain('BRAVO')
    expect(contents).not.toContain(secondPrompt)
    expect(contents).toContain(`"messageUuid":"${firstAnswer}"`)
    expect(fork.resumeCursor).toBeTruthy()
    expect(fork.resumeCursor).not.toBe(firstAnswer)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect((await readdir(project)).sort()).toEqual(
      [`${source}.jsonl`, `${fork.sessionId}.jsonl`].sort()
    )
    if (process.platform !== 'win32') {
      expect((await stat(forkPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('starts an empty fork when no turn remains', async () => {
    expect(await forkBefore(firstPrompt)).toMatchObject({ materialized: true })
    expect(await readdir(project)).toEqual([`${source}.jsonl`])
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('skips a torn transcript line instead of failing the rewind', async () => {
    const damaged = `{broken-json}\n${original}{"type":`
    await writeFile(path, damaged)
    const fork = await forkBefore(secondPrompt)
    expect(fork).toMatchObject({ materialized: true, throughEntryId: firstAnswer })
    const contents = await readFile(join(project, `${fork?.sessionId}.jsonl`), 'utf8')
    expect(contents).toContain('ALPHA')
    expect(contents).not.toContain('BRAVO')
    expect(await readFile(path, 'utf8')).toBe(damaged)
  })
})
