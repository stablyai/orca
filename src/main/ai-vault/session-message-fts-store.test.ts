import { mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAiVaultTestSession } from '../../shared/ai-vault-session-test-session'
import {
  aiVaultMessageFtsSyncGate,
  AiVaultSessionMessageFtsStore
} from './session-message-fts-store'

const tempDirs: string[] = []

afterEach(() => {
  aiVaultMessageFtsSyncGate.wait = async () => {}
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function writeTranscript(lines: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-vault-msg-fts-'))
  tempDirs.push(directory)
  const filePath = join(directory, 'session.jsonl')
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf-8')
  return filePath
}

async function createStore(): Promise<AiVaultSessionMessageFtsStore> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-vault-msg-fts-db-'))
  tempDirs.push(directory)
  return AiVaultSessionMessageFtsStore.open(join(directory, 'messages.sqlite'))
}

describe('AiVaultSessionMessageFtsStore', () => {
  it('matches CJK and code substrings and jumps to the message offset', async () => {
    const filePath = await writeTranscript([
      JSON.stringify({
        type: 'user',
        message: { content: '请生成二维码 and keep useEffect( in the hook' }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will add the QR helper' },
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'echo tool-secret-only' }
            }
          ]
        }
      })
    ])
    const session = createAiVaultTestSession({
      id: 'claude:cjk',
      title: 'QR helper',
      filePath
    })
    const store = await createStore()
    expect(await store.sync([session])).toEqual({ upserted: 1, deleted: 0 })
    expect(await store.sync([session])).toEqual({ upserted: 0, deleted: 0 })

    const cjk = store.search({
      query: '二维码',
      searchScope: 'fullWithoutTools',
      sessionIds: [session.id]
    })
    expect(cjk.degraded).toBe(false)
    expect(cjk.matchedIds).toEqual(['claude:cjk'])
    expect(cjk.hits[0]?.snippet).toContain('二维码')
    expect(cjk.hits[0]?.jump.messageId).toEqual(expect.any(Number))
    expect(cjk.hits[0]?.jump.lineNumber).toBe(1)
    expect(cjk.hits[0]?.jump.byteOffset).toBe(0)
    expect(cjk.hits[0]?.jump.sessionId).toBe('claude:cjk')
    expect(cjk.hits[0]?.jump.filePath).toBe(filePath)
    expect(cjk.hits[0]?.jump.matchLength).toBe(3)

    const code = store.search({
      query: 'useEffect(',
      searchScope: 'user',
      sessionIds: [session.id]
    })
    expect(code.matchedIds).toEqual(['claude:cjk'])
    expect(code.hits[0]?.jump.matchLength).toBe('useEffect('.length)

    const toolOnly = store.search({
      query: 'tool-secret-only',
      searchScope: 'fullWithoutTools',
      sessionIds: [session.id]
    })
    expect(toolOnly.matchedIds).toEqual([])

    const toolFull = store.search({
      query: 'tool-secret-only',
      searchScope: 'full',
      sessionIds: [session.id]
    })
    expect(toolFull.matchedIds).toEqual(['claude:cjk'])
    store.close()
  })

  it('falls back to LIKE for queries shorter than 3 code points', async () => {
    const filePath = await writeTranscript([
      JSON.stringify({ type: 'user', message: { content: 'QR helper ab' } })
    ])
    const session = createAiVaultTestSession({ id: 'claude:short', filePath })
    const store = await createStore()
    await store.sync([session])
    const result = store.search({
      query: 'ab',
      searchScope: 'user',
      sessionIds: [session.id]
    })
    expect(result.degraded).toBe(true)
    expect(result.matchedIds).toEqual(['claude:short'])
    store.close()
  })

  it('serializes overlapping syncs so the latest list wins', async () => {
    const firstPath = await writeTranscript([
      JSON.stringify({ type: 'user', message: { content: 'first-only-token' } })
    ])
    const secondPath = await writeTranscript([
      JSON.stringify({ type: 'user', message: { content: 'second-only-token' } })
    ])
    const first = createAiVaultTestSession({ id: 'claude:first', filePath: firstPath })
    const second = createAiVaultTestSession({ id: 'claude:second', filePath: secondPath })
    const store = await createStore()
    let release!: () => void
    let held = false
    aiVaultMessageFtsSyncGate.wait = () => {
      if (held) {
        return Promise.resolve()
      }
      held = true
      return new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const firstSync = store.sync([first])
    await vi.waitFor(() => {
      expect(release).toEqual(expect.any(Function))
    })
    const secondSync = store.sync([first, second])
    release()
    await Promise.all([firstSync, secondSync])
    expect(
      store.search({
        query: 'second-only-token',
        searchScope: 'user',
        sessionIds: [first.id, second.id]
      }).matchedIds
    ).toEqual(['claude:second'])
    store.close()
  })

  it('drops a previously indexed transcript that is no longer local', async () => {
    const filePath = await writeTranscript([
      JSON.stringify({ type: 'user', message: { content: 'vanished-token-xyz' } })
    ])
    const session = createAiVaultTestSession({ id: 'claude:gone', filePath })
    const store = await createStore()
    await store.sync([session])
    expect(
      store.search({
        query: 'vanished-token-xyz',
        searchScope: 'user',
        sessionIds: [session.id]
      }).indexedSessionCount
    ).toBe(1)
    unlinkSync(filePath)
    expect(await store.sync([session])).toEqual({ upserted: 0, deleted: 1 })
    const result = store.search({
      query: 'vanished-token-xyz',
      searchScope: 'user',
      sessionIds: [session.id]
    })
    expect(result.indexedSessionCount).toBe(0)
    expect(result.matchedIds).toEqual([])
    store.close()
  })

  it('jumps to the transcript file that produced the match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-vault-msg-fts-grok-'))
    tempDirs.push(directory)
    const filePath = join(directory, 'summary.json')
    const chatPath = join(directory, 'chat_history.jsonl')
    await writeFile(
      filePath,
      `${JSON.stringify({ type: 'user', message: { content: 'summary-only-token' } })}\n`,
      'utf-8'
    )
    await writeFile(
      chatPath,
      `${JSON.stringify({ type: 'user', message: { content: 'chat-history-only-token' } })}\n`,
      'utf-8'
    )
    const session = createAiVaultTestSession({
      id: 'grok:two',
      agent: 'grok',
      filePath
    })
    const store = await createStore()
    await store.sync([session])
    const summaryHit = store.search({
      query: 'summary-only-token',
      searchScope: 'user',
      sessionIds: [session.id]
    })
    expect(summaryHit.hits[0]?.jump.filePath).toBe(filePath)
    const chatHit = store.search({
      query: 'chat-history-only-token',
      searchScope: 'user',
      sessionIds: [session.id]
    })
    expect(chatHit.hits[0]?.jump.filePath).toBe(chatPath)
    store.close()
  })

  it('keeps CRLF byte offsets aligned with the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-vault-msg-fts-crlf-'))
    tempDirs.push(directory)
    const filePath = join(directory, 'session.jsonl')
    const first = JSON.stringify({ type: 'user', message: { content: 'crlf-first-line' } })
    const second = JSON.stringify({ type: 'user', message: { content: 'crlf-second-line' } })
    await writeFile(filePath, `${first}\r\n${second}\r\n`, 'utf-8')
    const session = createAiVaultTestSession({ id: 'claude:crlf', filePath })
    const store = await createStore()
    await store.sync([session])
    const result = store.search({
      query: 'crlf-second-line',
      searchScope: 'user',
      sessionIds: [session.id]
    })
    expect(result.hits[0]?.jump.lineNumber).toBe(2)
    expect(result.hits[0]?.jump.byteOffset).toBe(Buffer.byteLength(`${first}\r\n`, 'utf8'))
    store.close()
  })

  it('indexes a later grok transcript when the first target is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-vault-msg-fts-missing-first-'))
    tempDirs.push(directory)
    const filePath = join(directory, 'summary.json')
    const chatPath = join(directory, 'chat_history.jsonl')
    await writeFile(
      filePath,
      `${JSON.stringify({ type: 'user', message: { content: 'summary-only-token' } })}\n`,
      'utf-8'
    )
    await writeFile(
      chatPath,
      `${JSON.stringify({ type: 'user', message: { content: 'chat-history-only-token' } })}\n`,
      'utf-8'
    )
    const session = createAiVaultTestSession({
      id: 'grok:missing-first',
      agent: 'grok',
      filePath
    })
    const store = await createStore()
    await store.sync([session])
    unlinkSync(filePath)
    expect(
      await store.sync([{ ...session, messageCount: session.messageCount + 1 }])
    ).toEqual({ upserted: 1, deleted: 0 })
    const result = store.search({
      query: 'chat-history-only-token',
      searchScope: 'user',
      sessionIds: [session.id]
    })
    expect(result.indexedSessionCount).toBe(1)
    expect(result.matchedIds).toEqual(['grok:missing-first'])
    expect(result.hits[0]?.jump.filePath).toBe(chatPath)
    store.close()
  })

  it('leaves a session unindexed when a local transcript cannot be read', async () => {
    const filePath = await writeTranscript([
      JSON.stringify({ type: 'user', message: { content: 'readable-then-dir' } })
    ])
    const session = createAiVaultTestSession({ id: 'claude:unreadable', filePath })
    const store = await createStore()
    await store.sync([session])
    unlinkSync(filePath)
    mkdirSync(filePath)
    expect(await store.sync([{ ...session, messageCount: session.messageCount + 1 }])).toEqual({
      upserted: 0,
      deleted: 1
    })
    expect(
      store.search({
        query: 'readable-then-dir',
        searchScope: 'user',
        sessionIds: [session.id]
      }).indexedSessionCount
    ).toBe(0)
    store.close()
  })
})
