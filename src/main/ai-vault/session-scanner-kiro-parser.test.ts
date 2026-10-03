import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseKiroSessionFile } from './session-scanner-kiro-parser'
import { isKiroSessionManifestPath } from './session-scanner-kiro-paths'
import type { FileWithMtime } from './session-scanner-types'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

const SESSION_ID = 'sess_dc17e658-cf15-4822-80df-0f356f21879a'

// Mirrors the session.json kiro-cli 2.27.0 writes for a V3 `work` session.
const MANIFEST = {
  schemaVersion: '1',
  id: SESSION_ID,
  title: 'Execute PowerShell Sleep Command',
  agentMode: 'work',
  workspacePaths: ['/private/tmp/kiro-test-proj'],
  createdAt: '2026-10-02T16:04:12.112Z',
  lastModifiedAt: '2026-10-02T16:04:35.400Z',
  modelId: 'claude-opus-5.5'
}

// Mirrors messages.jsonl: one record per line with the turn content under `payload`.
const MESSAGE_LINES = [
  { id: 'm1', timestamp: '2026-10-02T16:04:12.200Z', payload: { type: 'session_start' } },
  {
    id: 'm2',
    timestamp: '2026-10-02T16:04:12.300Z',
    payload: { type: 'user', content: 'Run the shell command: echo dev-ok', images: [] }
  },
  {
    id: 'm3',
    timestamp: '2026-10-02T16:04:13.000Z',
    payload: { type: 'assistant', operationType: 'Reasoning', content: 'thinking about it' }
  },
  {
    id: 'm4',
    timestamp: '2026-10-02T16:04:14.000Z',
    payload: { type: 'tool_call', executionId: 'e1' }
  },
  {
    id: 'm5',
    timestamp: '2026-10-02T16:04:30.000Z',
    payload: { type: 'assistant', operationType: 'Say', content: 'done' }
  },
  {
    id: 'm6',
    timestamp: '2026-10-02T16:04:31.000Z',
    payload: { type: 'assistant', operationType: 'Summary', content: 'conversation summary' }
  }
]

async function writeKiroSession(options: {
  manifest?: Record<string, unknown>
  messageLines?: Record<string, unknown>[] | null
}): Promise<{ file: FileWithMtime }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-kiro-vault-'))
  tempDirs.push(root)
  const sessionDir = join(root, '5fab923ac92fb45c', SESSION_ID)
  await mkdir(sessionDir, { recursive: true })
  const manifestPath = join(sessionDir, 'session.json')
  await writeFile(manifestPath, JSON.stringify(options.manifest ?? MANIFEST))
  const lines = options.messageLines === undefined ? MESSAGE_LINES : options.messageLines
  if (lines) {
    await writeFile(
      join(sessionDir, 'messages.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
    )
  }
  const mtimeMs = Date.parse('2026-10-02T16:04:35.400Z')
  return { file: { path: manifestPath, mtimeMs, modifiedAt: new Date(mtimeMs).toISOString() } }
}

describe('parseKiroSessionFile', () => {
  it('returns null for a malformed session.json', async () => {
    const { file } = await writeKiroSession({})
    await writeFile(file.path, '{not-json')

    await expect(parseKiroSessionFile(file, 'darwin')).resolves.toBeNull()
  })

  it('parses the manifest and the user/assistant turns of the transcript', async () => {
    const { file } = await writeKiroSession({})
    const session = await parseKiroSessionFile(file, 'darwin')

    expect(session?.agent).toBe('kiro')
    expect(session?.sessionId).toBe(SESSION_ID)
    expect(session?.title).toBe('Execute PowerShell Sleep Command')
    expect(session?.cwd).toBe('/private/tmp/kiro-test-proj')
    expect(session?.model).toBe('claude-opus-5.5')
    // Reasoning and Summary entries are not replies the user saw.
    expect(session?.messageCount).toBe(2)
    expect(session?.previewMessages).toEqual([
      {
        role: 'user',
        text: 'Run the shell command: echo dev-ok',
        timestamp: '2026-10-02T16:04:12.300Z'
      },
      { role: 'assistant', text: 'done', timestamp: '2026-10-02T16:04:30.000Z' }
    ])
    expect(session?.createdAt).toBe('2026-10-02T16:04:12.112Z')
  })

  it('builds a workspace-scoped resume command through the chat subcommand', async () => {
    const { file } = await writeKiroSession({})
    const session = await parseKiroSessionFile(file, 'darwin')

    expect(session?.resumeCommand).toBe(
      `cd '/private/tmp/kiro-test-proj' && kiro-cli chat --tui --resume-id '${SESSION_ID}'`
    )
  })

  it('surfaces an unreadable manifest instead of answering "no session"', async () => {
    const { file } = await writeKiroSession({})
    await rm(file.path)
    await mkdir(file.path)

    await expect(parseKiroSessionFile(file, 'darwin')).rejects.toThrow()
  })

  it('surfaces an unreadable transcript instead of listing a partial session', async () => {
    const { file } = await writeKiroSession({ messageLines: null })
    await mkdir(join(dirname(file.path), 'messages.jsonl'))

    await expect(parseKiroSessionFile(file, 'darwin')).rejects.toThrow()
  })

  it('still lists a session that has no transcript yet', async () => {
    const { file } = await writeKiroSession({ messageLines: null })
    const session = await parseKiroSessionFile(file, 'darwin')

    expect(session?.title).toBe('Execute PowerShell Sleep Command')
    expect(session?.messageCount).toBe(0)
  })

  it('falls back to the first prompt when the manifest has no title', async () => {
    const { file } = await writeKiroSession({ manifest: { ...MANIFEST, title: '' } })
    const session = await parseKiroSessionFile(file, 'darwin')

    expect(session?.title).toBe('Run the shell command: echo dev-ok')
  })
})

describe('isKiroSessionManifestPath', () => {
  it('matches only session.json inside a sess_ directory', () => {
    expect(isKiroSessionManifestPath(join('h', SESSION_ID, 'session.json'))).toBe(true)
    expect(isKiroSessionManifestPath(join('h', SESSION_ID, 'messages.jsonl'))).toBe(false)
    expect(isKiroSessionManifestPath(join('cli', '00a05f6b.json'))).toBe(false)
  })
})
