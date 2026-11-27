import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { withFullFirstUserPromptCapture } from '../../prompts/session-scanner-first-user-prompt-capture'
import type { TranscriptMessage } from '../../transcripts/session-transcript-consumers'
import { parseOpenCodeSessionFile } from './session-scanner-opencode-parser'
import { SessionParseCacheDatabase } from '../../parse-cache/session-parse-cache-database'
import { writePreviousSessionParseRows } from '../../parse-cache/session-parse-cache-previous-row.test-fixture'

it('reads the separately stored OpenCode message parts in their recorded order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-opencode-json-parts-'))
  const time = 1784109600000
  const put = async (path: string, record: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(record))
  }
  try {
    const path = join(root, 'session', 'project', 'ses_saved.json')
    await put(path, {
      id: 'ses_saved',
      title: 'Build investigation',
      directory: root,
      time: { created: time, updated: time + 2 }
    })
    for (const [id, role, created, content] of [
      ['msg_user', 'user', time, undefined],
      ['msg_assistant', 'assistant', time + 1, undefined],
      ['msg_inline', 'assistant', time + 2, 'An older inline message.']
    ] as const) {
      await put(join(root, 'message', 'ses_saved', `${id}.json`), {
        id,
        sessionID: 'ses_saved',
        role,
        time: { created },
        content
      })
    }
    // MessageV2 stores parts separately; their IDs, not directory enumeration, order the text.
    for (const [messageID, id, content] of [
      ['msg_user', 'prt_02', { type: 'text', text: 'Keep the command output.' }],
      ['msg_user', 'prt_01', { type: 'text', text: 'Inspect the build failure.' }],
      ['msg_assistant', 'prt_01', { type: 'reasoning', text: 'Checking the compiler.' }],
      ['msg_assistant', 'prt_03', { type: 'text', text: 'The dependency is missing.' }],
      [
        'msg_assistant',
        'prt_02',
        {
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'npm test' }, output: 'Missing package' }
        }
      ]
    ] as const) {
      await put(join(root, 'part', messageID, `${id}.json`), {
        id,
        messageID,
        sessionID: 'ses_saved',
        ...content
      })
    }
    const messages: TranscriptMessage[] = []
    const session = await withFullFirstUserPromptCapture(() =>
      parseOpenCodeSessionFile(
        { path, mtimeMs: time + 2, modifiedAt: '2026-07-15T10:00:00.002Z' },
        'linux',
        { active: true, push: (message) => messages.push(message) }
      )
    )
    expect(session?.firstUserPrompt).toBe('Inspect the build failure.\nKeep the command output.')
    expect(session?.previewMessages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Inspect the build failure. Keep the command output.' },
      { role: 'assistant', text: 'The dependency is missing.' },
      { role: 'assistant', text: 'An older inline message.' }
    ])
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Inspect the build failure.\nKeep the command output.' },
      { role: 'assistant', text: 'Checking the compiler.' },
      { role: 'tool', text: 'bash: npm test' },
      { role: 'tool', text: 'Missing package' },
      { role: 'assistant', text: 'The dependency is missing.' },
      { role: 'assistant', text: 'An older inline message.' }
    ])
    const cachePath = join(root, 'session-parse-cache.sqlite')
    const entry = { mtimeMs: time, sizeBytes: 100, platform: 'linux' as const, session }
    const sqliteKey = join(root, 'opencode.db#ses_saved')
    writePreviousSessionParseRows(cachePath, [
      [
        path,
        {
          ...entry,
          session: session && { ...session, previewMessages: [], firstUserPrompt: undefined }
        }
      ],
      [sqliteKey, entry]
    ])
    let db = new SessionParseCacheDatabase(cachePath)
    try {
      expect(db.read(path)).toBeUndefined()
      expect(db.read(sqliteKey)?.session).toEqual(session)
      db.write([[path, entry]], time)
      db.close()
      db = new SessionParseCacheDatabase(cachePath)
      expect(db.read(path)?.session?.firstUserPrompt).toBe(
        'Inspect the build failure.\nKeep the command output.'
      )
    } finally {
      db.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
