import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { parseDshSessionBytes } from './session-scanner-dsh-parser'
import type { TranscriptMessage } from './session-transcript-consumers'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'

// Payloads from pinned 639ed015 legacy.spec.ts and tool-role.spec.ts, never live model replies.
function header(version: number, seeded = false) {
  return {
    type: 'session',
    version,
    id: 'codec-proof',
    cwd: '/tmp/folder',
    createdAt: 1,
    delegationDepth: 0,
    ...(version >= 2 ? { isSeeded: seeded } : {})
  }
}
function user(seq: number, text: string) {
  return {
    type: 'user/message',
    seq,
    time: seq + 2,
    data: {
      id: `user-${seq}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }]
    }
  }
}
function boundary(seq: number) {
  return { type: 'session/end-seed', seq, time: seq + 2, data: { inherited: true } }
}
function parse(version: number, rows: unknown[], compressed = false) {
  const text = rows.map((row) => `${JSON.stringify(row)}\n`)
  const bytes = Buffer.concat(
    text.map((line) => (compressed ? zstdCompressSync(Buffer.from(line)) : Buffer.from(line)))
  )
  const messages: TranscriptMessage[] = []
  let reads = 0
  const session = withFullFirstUserPromptCapture(() =>
    parseDshSessionBytes(
      {
        path: `/tmp/.dsh/sessions/project/codec-proof/session${version ? `.v${version}` : ''}.jsonl${compressed ? '.zstd' : ''}`,
        mtimeMs: 100,
        modifiedAt: '2026-10-02T00:00:00Z'
      },
      async function* () {
        reads++
        for (let start = 0; start < bytes.length; start += 17) {
          yield bytes.subarray(start, start + 17)
        }
      },
      'linux',
      {},
      { active: true, push: (message) => messages.push(message) }
    )
  )
  return { session, messages, reads: () => reads }
}

describe('released DSH codec contracts', () => {
  it.each([0, 1, 2, 3, 4])(
    'reads persisted v%s rows validated by the official published codecs',
    async (version) => {
      const bytes = await readFile(
        new URL(`./__fixtures__/dsh-codec-v${version}.jsonl`, import.meta.url)
      )
      const messages: TranscriptMessage[] = []
      const session = await parseDshSessionBytes(
        {
          path: `/tmp/.dsh/sessions/project/codec-proof/session${version ? `.v${version}` : ''}.jsonl`,
          mtimeMs: 100,
          modifiedAt: '2026-10-02T00:00:00Z'
        },
        async function* () {
          yield bytes
        },
        'linux',
        {},
        { active: true, push: (message) => messages.push(message) }
      )
      expect(session?.messageCount).toBe(1)
      expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: 'user', text: 'Synthetic official-codec human prompt' },
        { role: 'tool', text: 'Synthetic official-codec tool output' }
      ])
    }
  )

  it.each([2, 3, 4])(
    'excludes inherited context through the LAST marker in v%s from every consumer',
    async (version) => {
      const proof = parse(
        version,
        [
          header(version, true),
          user(0, 'Grandparent opening'),
          boundary(1),
          user(2, 'Parent opening between markers'),
          boundary(3),
          user(4, 'This fork opening')
        ],
        true
      )
      const session = await proof.session
      expect(proof.reads()).toBe(2)
      expect(session?.messageCount).toBe(1)
      expect(session?.firstUserPrompt).toBe('This fork opening')
      expect(session?.title).toBe('This fork opening')
      expect(session?.previewMessages.map((message) => message.text)).toEqual(['This fork opening'])
      expect(proof.messages.map((message) => message.text)).toEqual(['This fork opening'])
    }
  )

  it.each([0, 1, 2, 3, 4])(
    'publishes the actual v%s tool shape as a tool without counting it as a human prompt',
    async (version) => {
      const content = [{ type: 'text', text: 'Synthetic codec tool output' }]
      const source = { kind: 'tool', callId: 'call-1' }
      const message =
        version === 4
          ? { id: 'result-1', role: 'tool', source, toolCallId: 'call-1', content, isError: false }
          : {
              id: 'result-1',
              role: 'user',
              source,
              content: [{ type: 'tool-result', toolCallId: 'call-1', content, isError: false }]
            }
      const proof = parse(version, [
        header(version),
        user(0, 'Human opening'),
        {
          type: 'tool/result',
          seq: 1,
          time: 3,
          data: { turn: 1, step: 1, message },
          surfaceOp: 'append'
        }
      ])
      const session = await proof.session
      expect(proof.reads()).toBe(1)
      expect(session?.messageCount).toBe(1)
      expect(session?.firstUserPrompt).toBe('Human opening')
      expect(session?.previewMessages.at(-1)).toMatchObject({
        role: 'tool',
        text: 'Synthetic codec tool output'
      })
      expect(proof.messages.at(-1)).toMatchObject({
        role: 'tool',
        text: 'Synthetic codec tool output'
      })
    }
  )

  it('normalizes genuine pre-identity v0 flat user/assistant/tool payloads', async () => {
    const proof = parse(0, [
      header(0),
      {
        type: 'user/message',
        seq: 0,
        time: 2,
        data: { content: [{ type: 'text', text: 'Legacy human' }], source: { kind: 'user' } },
        surfaceOp: 'append'
      },
      {
        type: 'assistant/message',
        seq: 1,
        time: 3,
        data: {
          turn: 1,
          step: 1,
          content: [{ type: 'text', text: 'Synthetic legacy reply' }],
          provenance: { provider: 'fixture', model: 'fixture-model' }
        },
        surfaceOp: 'append'
      },
      {
        type: 'tool/result',
        seq: 2,
        time: 4,
        data: {
          turn: 1,
          step: 1,
          callId: 'call-1',
          content: [{ type: 'text', text: 'Synthetic legacy tool' }],
          isError: false
        },
        surfaceOp: 'append'
      }
    ])
    const session = await proof.session
    expect(session?.messageCount).toBe(2)
    expect(session?.model).toBe('fixture-model')
    expect(session?.firstUserPrompt).toBe('Legacy human')
    expect(proof.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Legacy human' },
      { role: 'assistant', text: 'Synthetic legacy reply' },
      { role: 'tool', text: 'Synthetic legacy tool' }
    ])
  })

  it('rejects unseeded inherited boundaries instead of silently accepting them', async () => {
    await expect(parse(4, [header(4), boundary(0), user(1, 'Invalid')]).session).rejects.toThrow(
      'unseeded'
    )
  })
})
