import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareKimiImport } from './journal-kimi-import'

const SESSION = 'session_f1f561b0-4bea-4ae1-92fa-1a031f7d2152'
const user = (id: string, text: string) =>
  JSON.stringify({
    type: 'context.append_message',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      id,
      origin: { kind: 'user' }
    }
  })
const reply = (uuid: string, text: string) =>
  JSON.stringify({
    type: 'context.append_loop_event',
    event: { type: 'content.part', uuid, block: 0, part: { type: 'text', text } }
  })
const undo = (branch: string, base: { branch: string; line: number }, line: number) => [
  JSON.stringify({
    type: 'agent.switched',
    branch,
    reason: 'undo',
    base,
    turns: 1,
    legacyUndoLine: line + 1
  }),
  JSON.stringify({ type: 'context.undo', count: 1 }),
  JSON.stringify({ type: 'context.undone', turns: 1 })
]

// Record shapes from Kimi Code 2.7.2 after `/undo` twice: the second undo branches from the first.
const WIRE = [
  JSON.stringify({ type: 'metadata', protocol_version: '1.5' }),
  user('msg_alpha', 'alpha'),
  reply('reply-alpha', 'ECHO alpha'),
  user('msg_beta', 'beta'),
  reply('reply-beta', 'ECHO beta'),
  ...undo('b1', { branch: 'main', line: 3 }, 6),
  user('msg_gamma', 'gamma'),
  reply('reply-gamma', 'ECHO gamma'),
  ...undo('b2', { branch: 'b1', line: 8 }, 11),
  user('msg_delta', 'delta'),
  reply('reply-delta', 'ECHO delta')
]

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-kimi-journal-'))
})

afterEach(async () => rm(root, { recursive: true, force: true }))

describe('prepareKimiImport', () => {
  it('imports only the turns /undo left on the conversation', async () => {
    const wire = join(root, 'wd_repo_9b1d92600e40', SESSION, 'agents', 'main', 'wire.jsonl')
    await mkdir(join(wire, '..'), { recursive: true })
    await writeFile(wire, `${WIRE.join('\n')}\n`)
    const result = await prepareKimiImport(
      SESSION,
      { filePath: wire },
      { inlineHeadBytes: 16 * 1024 },
      1024 * 1024
    )
    expect(
      result.ok
        ? result.items.map((item) => item.identity.provider === 'legacy' && item.identity.recordId)
        : result
    ).toEqual(['msg_alpha', 'reply-alpha', 'msg_delta', 'reply-delta'])
  })

  it('finds nothing to adopt once every turn was undone', async () => {
    const wire = join(root, 'wd_repo_9b1d92600e40', SESSION, 'agents', 'main', 'wire.jsonl')
    await mkdir(join(wire, '..'), { recursive: true })
    await writeFile(
      wire,
      `${WIRE.slice(0, 5).join('\n')}\n${undo('b1', { branch: 'main', line: 1 }, 6).join('\n')}\n`
    )
    const result = await prepareKimiImport(
      SESSION,
      { filePath: wire },
      { inlineHeadBytes: 16 * 1024 },
      1024 * 1024
    )
    expect(result).toMatchObject({ ok: true, items: [], sourceEmpty: true })
  })

  it('keeps the conversation when undone turns alone would fill the history budget', async () => {
    const undone = Array.from({ length: 20 }, (_, index) =>
      user(`msg_undone_${index}`, 'x'.repeat(1024))
    )
    const wire = join(root, 'wd_repo_9b1d92600e40', SESSION, 'agents', 'main', 'wire.jsonl')
    await mkdir(join(wire, '..'), { recursive: true })
    await writeFile(
      wire,
      `${[...WIRE.slice(0, 3), ...undone, ...undo('b1', { branch: 'main', line: 3 }, 24)].join('\n')}\n`
    )
    const result = await prepareKimiImport(
      SESSION,
      { filePath: wire },
      { inlineHeadBytes: 16 * 1024 },
      4096
    )
    expect(
      result.ok
        ? result.items.map((item) => item.identity.provider === 'legacy' && item.identity.recordId)
        : result
    ).toEqual(['msg_alpha', 'reply-alpha'])
  })
})
