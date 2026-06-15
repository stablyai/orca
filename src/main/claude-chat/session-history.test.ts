import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  encodeProjectDir,
  projectDirFor,
  listSessions,
  loadSessionTranscript
} from './session-history'

describe('encodeProjectDir', () => {
  it('replaces / and . with -', () => {
    expect(encodeProjectDir('/Users/x/.foo/bar')).toBe('-Users-x--foo-bar')
  })

  it('handles simple path without dots', () => {
    expect(encodeProjectDir('/home/user/projects')).toBe('-home-user-projects')
  })
})

describe('projectDirFor', () => {
  it('joins home/.claude/projects/<encoded>', () => {
    expect(projectDirFor('/home/user', '/projects/app')).toBe(
      '/home/user/.claude/projects/-projects-app'
    )
  })
})

describe('listSessions', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'orca-session-test-'))
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function makeProjectDir(cwd: string): string {
    const encoded = encodeProjectDir(cwd)
    const dir = join(tmpHome, '.claude', 'projects', encoded)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function writeSession(dir: string, sessionId: string, lines: object[]): void {
    const content = lines.map((l) => JSON.stringify(l)).join('\n')
    writeFileSync(join(dir, `${sessionId}.jsonl`), content)
  }

  it('returns [] when project dir does not exist', async () => {
    const result = await listSessions('/no/such/cwd', tmpHome)
    expect(result).toEqual([])
  })

  it('returns session with correct id and summary from first user message', async () => {
    const dir = makeProjectDir('/my/project')
    writeSession(dir, 'session-abc', [
      {
        type: 'user',
        sessionId: 'session-abc',
        timestamp: '2026-05-12T09:52:38.280Z',
        cwd: '/my/project',
        message: { role: 'user', content: 'Hello, please help me fix this bug' }
      },
      {
        type: 'assistant',
        sessionId: 'session-abc',
        timestamp: '2026-05-12T09:52:40.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Sure, let me help.' }]
        }
      }
    ])

    const result = await listSessions('/my/project', tmpHome)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('session-abc')
    expect(result[0]?.summary).toBe('Hello, please help me fix this bug')
    expect(result[0]?.date).toBe('2026-05-12T09:52:38.280Z')
  })

  it('extracts summary from content array (first text block)', async () => {
    const dir = makeProjectDir('/my/project2')
    writeSession(dir, 'session-xyz', [
      {
        type: 'user',
        sessionId: 'session-xyz',
        timestamp: '2026-05-13T10:00:00.000Z',
        cwd: '/my/project2',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Can you refactor this code?' }]
        }
      }
    ])

    const result = await listSessions('/my/project2', tmpHome)
    expect(result).toHaveLength(1)
    expect(result[0]?.summary).toBe('Can you refactor this code?')
  })

  it('truncates summary to 80 chars', async () => {
    const dir = makeProjectDir('/my/project3')
    const longText = 'A'.repeat(100)
    writeSession(dir, 'session-long', [
      {
        type: 'user',
        timestamp: '2026-05-14T10:00:00.000Z',
        message: { role: 'user', content: longText }
      }
    ])

    const result = await listSessions('/my/project3', tmpHome)
    expect(result[0]?.summary).toHaveLength(80)
  })

  it('sorts newest first by date', async () => {
    const dir = makeProjectDir('/my/project4')
    writeSession(dir, 'session-old', [
      {
        type: 'user',
        timestamp: '2026-04-01T00:00:00.000Z',
        message: { role: 'user', content: 'Old message' }
      }
    ])
    writeSession(dir, 'session-new', [
      {
        type: 'user',
        timestamp: '2026-06-01T00:00:00.000Z',
        message: { role: 'user', content: 'New message' }
      }
    ])

    const result = await listSessions('/my/project4', tmpHome)
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('session-new')
    expect(result[1]?.id).toBe('session-old')
  })

  it('skips files with no usable user message', async () => {
    const dir = makeProjectDir('/my/project5')
    writeSession(dir, 'session-empty', [
      { type: 'summary', content: 'some summary' },
      { type: 'system', message: { role: 'system' } }
    ])
    writeSession(dir, 'session-tool-only', [
      {
        type: 'user',
        timestamp: '2026-06-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: 'result' }]
        }
      }
    ])

    const result = await listSessions('/my/project5', tmpHome)
    expect(result).toHaveLength(0)
  })
})

describe('loadSessionTranscript', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'orca-transcript-test-'))
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('returns user and assistant message events in order, skipping non-message lines', async () => {
    const encoded = encodeProjectDir('/my/proj')
    const dir = join(tmpHome, '.claude', 'projects', encoded)
    mkdirSync(dir, { recursive: true })

    const lines = [
      { type: 'summary', content: 'A summary line' },
      {
        type: 'user',
        timestamp: '2026-05-12T09:52:38.280Z',
        message: { role: 'user', content: 'First user message' }
      },
      { type: 'queue-operation', op: 'something' },
      {
        type: 'assistant',
        timestamp: '2026-05-12T09:52:40.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Assistant response' }]
        }
      },
      {
        type: 'user',
        timestamp: '2026-05-12T09:52:45.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'ok', is_error: false }]
        }
      }
    ]

    writeFileSync(join(dir, 'ses-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))

    const events = await loadSessionTranscript('/my/proj', 'ses-1', tmpHome)

    expect(events).toHaveLength(3)
    expect((events[0] as { type: string })?.type).toBe('user')
    expect((events[1] as { type: string })?.type).toBe('assistant')
    expect((events[2] as { type: string })?.type).toBe('user')
    // message is preserved
    expect((events[0] as { message: { content: string } })?.message?.content).toBe(
      'First user message'
    )
  })
})
