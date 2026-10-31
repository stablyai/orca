import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { carryClaudeConversationToAccountHome } from './claude-chat-account-move'

const SESSION = '11111111-2222-4333-8444-555555555555'
const PROJECT = '-Users-dev-repo'

describe('carryClaudeConversationToAccountHome', () => {
  let root: string
  let homeA: string
  let homeB: string
  let homeC: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-claude-chat-move-'))
    homeA = join(root, 'a')
    homeB = join(root, 'b')
    homeC = join(root, 'c')
    for (const home of [homeA, homeB, homeC]) {
      mkdirSync(join(home, 'projects'), { recursive: true })
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const writeTranscript = (home: string, text = '{"type":"user"}\n') => {
    const path = join(home, 'projects', PROJECT, `${SESSION}.jsonl`)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
    return path
  }
  const carry = (sourceHomes = [homeA, homeC]) =>
    carryClaudeConversationToAccountHome({ sessionId: SESSION, sourceHomes, targetHome: homeB })

  it('links the transcript into the selected account under the same project', async () => {
    const source = writeTranscript(homeA)
    expect(await carry()).toBe(true)
    const target = join(homeB, 'projects', PROJECT, `${SESSION}.jsonl`)
    expect(statSync(target).ino).toBe(statSync(source).ino)
  })

  it('finds a transcript in any account the chat may have run in', async () => {
    writeTranscript(homeC, 'from c\n')
    expect(await carry()).toBe(true)
    expect(readFileSync(join(homeB, 'projects', PROJECT, `${SESSION}.jsonl`), 'utf8')).toBe(
      'from c\n'
    )
  })

  it('needs nothing when the selected account already shares the history', async () => {
    writeTranscript(homeB, 'shared\n')
    expect(await carry()).toBe(true)
    expect(readFileSync(join(homeB, 'projects', PROJECT, `${SESSION}.jsonl`), 'utf8')).toBe(
      'shared\n'
    )
  })

  it('switching back after a copy resumes the newest turns, not the copy left behind', async () => {
    // Across filesystems each account keeps its own copy, and only the one in use grows.
    const stale = writeTranscript(homeB, 'turn 1\n')
    utimesSync(stale, 1, 1)
    writeTranscript(homeA, 'turn 1\nturn 2\n')
    expect(await carry()).toBe(true)
    expect(readFileSync(stale, 'utf8')).toBe('turn 1\nturn 2\n')
  })

  it('keeps a copy that went its own way rather than overwrite its turns', async () => {
    const own = writeTranscript(homeB, 'turn 1\nturn 2b\n')
    utimesSync(own, 1, 1)
    writeTranscript(homeA, 'turn 1\nturn 2a\nturn 3a\n')
    expect(await carry()).toBe(true)
    expect(readFileSync(own, 'utf8')).toBe('turn 1\nturn 2b\n')
  })

  it('reports a conversation no known account holds', async () => {
    expect(await carry()).toBe(false)
  })
})
