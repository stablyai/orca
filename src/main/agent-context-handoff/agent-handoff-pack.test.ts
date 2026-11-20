import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TranscriptMessage } from '../ai-vault/transcripts/session-transcript-consumers'
import {
  buildAgentHandoffPack,
  isHandoffAgent,
  renderAgentHandoffPrompt,
  shapeHandoffMessages,
  type AgentHandoffPack
} from './agent-handoff-pack'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function message(role: TranscriptMessage['role'], text: string): TranscriptMessage {
  return { role, text, timestamp: null }
}

function packWith(messages: TranscriptMessage[]): AgentHandoffPack {
  return {
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Wire the widget',
    cwd: '/repo/app',
    model: null,
    createdAt: null,
    updatedAt: null,
    totalMessages: messages.length,
    mode: 'summary',
    messages,
    truncated: false
  }
}

describe('isHandoffAgent', () => {
  it('accepts only the three decoded agents', () => {
    expect(isHandoffAgent('claude')).toBe(true)
    expect(isHandoffAgent('codex')).toBe(true)
    expect(isHandoffAgent('pi')).toBe(true)
    expect(isHandoffAgent('opencode')).toBe(false)
    expect(isHandoffAgent(null)).toBe(false)
  })
})

describe('shapeHandoffMessages', () => {
  it('keeps the opening ask plus the recent tail in summary mode', () => {
    const messages = [message('user', 'goal')]
    for (let i = 0; i < 10; i += 1) {
      messages.push(message('assistant', `reply ${i}`))
    }
    const shaped = shapeHandoffMessages(messages, 'summary', 3, 1000)
    expect(shaped.messages.map((entry) => entry.text)).toEqual([
      'goal',
      'reply 7',
      'reply 8',
      'reply 9'
    ])
    expect(shaped.truncated).toBe(true)
  })

  it('returns the whole transcript in full mode', () => {
    const messages = [message('user', 'goal'), message('assistant', 'done')]
    const shaped = shapeHandoffMessages(messages, 'full')
    expect(shaped.messages).toEqual(messages)
    expect(shaped.truncated).toBe(false)
  })

  it('drops the oldest messages first when over the char budget', () => {
    const messages = [message('assistant', 'aaaa'), message('assistant', 'bbbb')]
    const shaped = shapeHandoffMessages(messages, 'full', 20, 5)
    expect(shaped.messages.map((entry) => entry.text)).toEqual(['bbbb'])
    expect(shaped.truncated).toBe(true)
  })

  it('does not duplicate the opening ask when it is already in the tail', () => {
    const messages = [message('user', 'goal'), message('assistant', 'done')]
    const shaped = shapeHandoffMessages(messages, 'summary', 5, 1000)
    expect(shaped.messages).toEqual(messages)
    expect(shaped.truncated).toBe(false)
  })

  it('keeps the opening ask while shedding the tail under a char budget', () => {
    const messages = [message('user', 'goal')]
    for (let i = 0; i < 6; i += 1) {
      messages.push(message('assistant', `reply ${i} with padding text`))
    }
    const shaped = shapeHandoffMessages(messages, 'summary', 20, 40)
    expect(shaped.messages[0]).toEqual(message('user', 'goal'))
    expect(shaped.truncated).toBe(true)
  })

  it('truncates a single oversized message instead of dropping it', () => {
    const shaped = shapeHandoffMessages([message('user', 'goals'.repeat(100))], 'full', 20, 10)
    expect(shaped.messages).toHaveLength(1)
    expect(shaped.messages[0]?.text).toBe(`${'goals'.repeat(100).slice(0, 10)}...`)
    expect(shaped.truncated).toBe(true)
  })

  it('handles an empty transcript', () => {
    expect(shapeHandoffMessages([], 'summary')).toEqual({ messages: [], truncated: false })
  })
})

describe('renderAgentHandoffPrompt', () => {
  it('renders session metadata followed by the transcript', () => {
    const rendered = renderAgentHandoffPrompt(
      packWith([message('user', 'goal'), message('assistant', 'done')])
    )
    expect(rendered).toContain('Continued from codex session "Wire the widget" (session-1)')
    expect(rendered).toContain('**user**: goal')
    expect(rendered).toContain('**assistant**: done')
  })

  it('marks truncated packs', () => {
    const rendered = renderAgentHandoffPrompt({ ...packWith([]), truncated: true })
    expect(rendered).toContain('(truncated)')
  })
})

describe('buildAgentHandoffPack', () => {
  it('returns null for a missing transcript', async () => {
    await expect(
      buildAgentHandoffPack('codex', join(tmpdir(), 'orca-no-such-handoff.jsonl'))
    ).resolves.toBeNull()
  })

  it('decodes a codex rollout into a summary pack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-handoff-codex-'))
    tempRoots.push(root)
    const sessionPath = join(root, 'sessions', '2026', '10', '18', 'rollout-handoff.jsonl')
    await mkdir(dirname(sessionPath), { recursive: true })
    const timestamp = '2026-10-18T10:00:00.000Z'
    await writeFile(
      sessionPath,
      [
        {
          timestamp,
          type: 'session_meta',
          payload: { id: 'handoff-session', history_mode: 'paginated', cwd: '/repo/app' }
        },
        {
          timestamp,
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'UserMessage', content: [{ type: 'text', text: 'wire the widget' }] }
          }
        },
        {
          timestamp,
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'wired it' }] }
          }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    )
    const pack = await buildAgentHandoffPack('codex', sessionPath)
    expect(pack?.agent).toBe('codex')
    expect(pack?.mode).toBe('summary')
    expect(pack?.messages).toEqual([
      { role: 'user', text: 'wire the widget', timestamp },
      { role: 'assistant', text: 'wired it', timestamp }
    ])
    expect(pack?.truncated).toBe(false)
  })
})
