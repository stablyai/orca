import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parseOpenCodeSessionFile } from './session-scanner-opencode-parser'

it('keeps message content when a numeric timestamp is outside the Date range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-opencode-time-'))
  try {
    const sessions = join(root, 'session', 'project')
    const messages = join(root, 'message', 'session-a')
    await mkdir(sessions, { recursive: true })
    await mkdir(messages, { recursive: true })
    const path = join(sessions, 'session-a.json')
    await writeFile(
      path,
      JSON.stringify({ id: 'session-a', title: 'Preserved conversation', time: { created: 1e20 } })
    )
    await writeFile(
      join(messages, 'message-a.json'),
      JSON.stringify({ role: 'user', content: 'Keep this message', time: { created: 1e20 } })
    )

    const session = await parseOpenCodeSessionFile({
      path,
      mtimeMs: Date.parse('2026-11-01T00:00:00.000Z'),
      modifiedAt: '2026-11-01T00:00:00.000Z'
    })

    expect(session?.title).toBe('Preserved conversation')
    expect(session?.createdAt).toBeNull()
    expect(session?.previewMessages).toEqual([
      { role: 'user', text: 'Keep this message', timestamp: null }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
