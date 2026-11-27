import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { expect, it, vi } from 'vitest'
import { wslGatedReaddir } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import type * as WslTranscriptFsAccess from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { readAiVaultFirstUserPrompt } from '../../prompts/session-first-user-prompt-read'
import { withFullFirstUserPromptCapture } from '../../prompts/session-scanner-first-user-prompt-capture'
import type { TranscriptMessage } from '../../transcripts/session-transcript-consumers'
import { parseOpenCodeSessionFile } from './session-scanner-opencode-parser'

vi.mock('../../../native-chat/transcript-filesystem/wsl-transcript-fs-access', async (original) => {
  const actual = await original<typeof WslTranscriptFsAccess>()
  return { ...actual, wslGatedReaddir: vi.fn(actual.wslGatedReaddir) }
})

const put = async (path: string, record: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(record))
}

it('reads the separately stored OpenCode message parts in their recorded order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-opencode-json-parts-'))
  const time = 1784109600000
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
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: 'build.log' },
            output: 'Missing package'
          }
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
      { role: 'assistant', text: 'Checking the compiler.\nThe dependency is missing.' },
      { role: 'tool', text: 'read: build.log' },
      { role: 'tool', text: 'Missing package' },
      { role: 'assistant', text: 'An older inline message.' }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reads only the newest preview parts when listing and the first prompt parts on demand', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-opencode-json-listing-'))
  const time = 1784109600000
  try {
    const path = join(root, 'session', 'project', 'ses_long.json')
    await put(path, { id: 'ses_long', directory: root, time: { created: time } })
    for (let index = 0; index < 40; index++) {
      const id = `msg_${String(index).padStart(3, '0')}`
      const role = index % 2 === 0 ? 'user' : 'assistant'
      await put(join(root, 'message', 'ses_long', `${id}.json`), {
        id,
        role,
        time: { created: time + index }
      })
      // Assistant turns here are tool-only, so listing must look past them for previews.
      await put(
        join(root, 'part', id, 'prt_01.json'),
        role === 'user'
          ? { type: 'text', text: `Prompt ${index}` }
          : { type: 'tool', tool: 'bash', state: { input: { command: 'ls' }, output: 'ok' } }
      )
    }
    const file = { path, mtimeMs: time, modifiedAt: '2026-07-15T10:00:00.000Z' }
    const summary = (session: Awaited<ReturnType<typeof parseOpenCodeSessionFile>>) => ({
      messageCount: session?.messageCount,
      previews: session?.previewMessages.map(({ text }) => text),
      truncated: session?.previewMessagesTruncated
    })
    const partReads = () =>
      vi
        .mocked(wslGatedReaddir)
        .mock.calls.filter(([directory]) => directory.includes(`${sep}part${sep}`)).length
    const full = await withFullFirstUserPromptCapture(() =>
      parseOpenCodeSessionFile(file, 'linux', { active: true, push: () => {} })
    )
    vi.mocked(wslGatedReaddir).mockClear()
    const listing = await parseOpenCodeSessionFile(file, 'linux')

    expect(summary(listing)).toEqual(summary(full))
    expect(summary(listing)).toEqual({
      messageCount: 40,
      previews: ['Prompt 30', 'Prompt 32', 'Prompt 34', 'Prompt 36', 'Prompt 38'],
      truncated: true
    })
    // The newest 12 messages hold one preview beyond the five kept.
    expect(partReads()).toBe(12)

    vi.mocked(wslGatedReaddir).mockClear()
    // The First Prompt card always sends the sessionId, which must not route legacy JSON to SQLite.
    expect(
      await readAiVaultFirstUserPrompt({ agent: 'opencode', filePath: path, sessionId: 'ses_long' })
    ).toEqual({ prompt: 'Prompt 0' })
    expect(partReads()).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
