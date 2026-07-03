import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseKimiSessionFile } from './session-scanner-kimi-parser'
import { clearKimiSessionIndexCache } from './session-scanner-kimi-paths'
import type { FileWithMtime } from './session-scanner-types'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
  clearKimiSessionIndexCache()
})

const SESSION_ID = 'session_4243babe-c33c-4ca3-8245-689c9e34ba3b'

// Mirrors a real `agents/main/wire.jsonl` produced by Kimi Code 0.18.0.
const WIRE_LINES = [
  { type: 'metadata', protocol_version: '1.4', created_at: 1781853559132 },
  { type: 'config.update', profileName: 'agent', systemPrompt: 'You are Kimi Code CLI...' },
  { type: 'config.update', modelAlias: 'mock-model', thinkingLevel: 'high', time: 1781853559132 },
  {
    type: 'turn.prompt',
    input: [{ type: 'text', text: 'Please explain this project briefly' }],
    origin: { kind: 'user' },
    time: 1781853559164
  },
  {
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Please explain this project briefly' }],
      toolCalls: [],
      origin: { kind: 'user' }
    },
    time: 1781853559164
  },
  {
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<system-reminder>\nAuto permission mode is active.\n</system-reminder>'
        }
      ],
      toolCalls: [],
      origin: { kind: 'injection', variant: 'permission_mode' }
    },
    time: 1781853559165
  },
  {
    type: 'context.append_loop_event',
    event: { type: 'step.begin', step: 1 },
    time: 1781853559165
  },
  {
    type: 'context.append_loop_event',
    event: {
      type: 'content.part',
      step: 1,
      part: { type: 'text', text: 'Hello! This is a mock response. ' }
    },
    time: 1781853559177
  },
  {
    type: 'context.append_loop_event',
    event: { type: 'step.end', step: 1, finishReason: 'end_turn' },
    time: 1781853559177
  },
  {
    type: 'usage.record',
    model: 'mock-model',
    usage: { inputOther: 12, output: 18, inputCacheRead: 0, inputCacheCreation: 0 },
    usageScope: 'turn',
    time: 1781853559177
  }
]

async function writeKimiSession(args: {
  sessionId?: string
  state?: Record<string, unknown>
  workDir?: string | null
  wireLines?: unknown[] | null
}): Promise<{ file: FileWithMtime }> {
  const home = await mkdtemp(join(tmpdir(), 'orca-kimi-'))
  tempDirs.push(home)
  const sessionId = args.sessionId ?? SESSION_ID
  const sessionDir = join(home, 'sessions', 'wd_kimi-test-proj_36fb0f9f4385', sessionId)
  await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true })

  const statePath = join(sessionDir, 'state.json')
  const state = args.state ?? {
    createdAt: '2026-06-19T07:19:19.118Z',
    updatedAt: '2026-06-19T07:19:19.161Z',
    title: 'Please explain this project briefly',
    isCustomTitle: false,
    agents: {
      main: { homedir: join(sessionDir, 'agents', 'main'), type: 'main', parentAgentId: null }
    },
    custom: {},
    lastPrompt: 'Please explain this project briefly'
  }
  await writeFile(statePath, JSON.stringify(state))

  if (args.workDir !== null) {
    await writeFile(
      join(home, 'session_index.jsonl'),
      `${JSON.stringify({ sessionId, sessionDir, workDir: args.workDir ?? '/private/tmp/kimi-test-proj' })}\n`
    )
  }

  if (args.wireLines !== null) {
    await writeFile(
      join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      (args.wireLines ?? WIRE_LINES).map((line) => JSON.stringify(line)).join('\n')
    )
  }

  const mtimeMs = Date.now()
  return { file: { path: statePath, mtimeMs, modifiedAt: new Date(mtimeMs).toISOString() } }
}

describe('parseKimiSessionFile', () => {
  it('returns null for malformed state.json', async () => {
    const { file } = await writeKimiSession({})
    await writeFile(file.path, '{not-json')

    await expect(parseKimiSessionFile(file, 'darwin')).resolves.toBeNull()
  })

  it('parses a full session from state.json + index + wire transcript', async () => {
    const { file } = await writeKimiSession({})
    const session = await parseKimiSessionFile(file, 'darwin')

    expect(session).not.toBeNull()
    expect(session?.agent).toBe('kimi')
    // The session id keeps the `session_` prefix that `kimi --session <id>` expects.
    expect(session?.sessionId).toBe(SESSION_ID)
    expect(session?.title).toBe('Please explain this project briefly')
    expect(session?.cwd).toBe('/private/tmp/kimi-test-proj')
    expect(session?.model).toBe('mock-model')
    expect(session?.totalTokens).toBe(30)
    // 1 real user turn + 1 assistant turn; the injected system-reminder is excluded.
    expect(session?.messageCount).toBe(2)
    expect(session?.previewMessages).toEqual([
      { role: 'user', text: 'Please explain this project briefly', timestamp: null },
      { role: 'assistant', text: 'Hello! This is a mock response.', timestamp: null }
    ])
    expect(session?.createdAt).toBe('2026-06-19T07:19:19.118Z')
    expect(session?.updatedAt).toBe('2026-06-19T07:19:19.161Z')
  })

  it('builds a work-dir-scoped resume command', async () => {
    const { file } = await writeKimiSession({})
    const session = await parseKimiSessionFile(file, 'darwin')
    expect(session?.resumeCommand).toBe(
      `cd '/private/tmp/kimi-test-proj' && kimi --session '${SESSION_ID}'`
    )
  })

  it('still lists a metadata-only session with no transcript yet', async () => {
    const { file } = await writeKimiSession({ wireLines: null })
    const session = await parseKimiSessionFile(file, 'darwin')
    expect(session?.title).toBe('Please explain this project briefly')
    expect(session?.messageCount).toBe(0)
    expect(session?.model).toBeNull()
  })

  it('lists a session even when the index (work dir) is missing', async () => {
    const { file } = await writeKimiSession({ workDir: null })
    const session = await parseKimiSessionFile(file, 'darwin')
    expect(session?.cwd).toBeNull()
    expect(session?.resumeCommand).toBe(`kimi --session '${SESSION_ID}'`)
  })

  it('keeps preview messages at the 220-char preview limit, not the 96-char title limit', async () => {
    const longReply = 'x'.repeat(300)
    const { file } = await writeKimiSession({
      wireLines: [
        {
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'y'.repeat(300) }],
            origin: { kind: 'user' }
          }
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'content.part', part: { type: 'text', text: longReply } }
        },
        { type: 'context.append_loop_event', event: { type: 'step.end' } }
      ]
    })
    const session = await parseKimiSessionFile(file, 'darwin')
    const [userPreview, assistantPreview] = session!.previewMessages
    // 220-char cap = 217 chars + '...'; the 96-char title cap would be 93 + '...'.
    expect(userPreview.text.length).toBe(220)
    expect(assistantPreview.text.length).toBe(220)
    expect(assistantPreview.text.endsWith('...')).toBe(true)
  })

  it('falls back to lastPrompt when the title is empty', async () => {
    const { file } = await writeKimiSession({
      state: {
        createdAt: '2026-06-19T07:19:19.118Z',
        updatedAt: '2026-06-19T07:19:19.161Z',
        title: '',
        lastPrompt: 'do the thing',
        agents: {}
      },
      wireLines: []
    })
    const session = await parseKimiSessionFile(file, 'darwin')
    expect(session?.title).toBe('do the thing')
  })
})
