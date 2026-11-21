import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readWorkerTranscript } from './worker-transcript-read'

function codexMessage(id: string, text: string): string {
  return JSON.stringify({
    timestamp: '2026-07-24T12:00:00.000Z',
    type: 'event_msg',
    payload: { id, type: 'agent_message', message: text }
  })
}

describe('worker transcript reads', () => {
  let directory: string
  let transcriptPath: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-worker-transcript-'))
    transcriptPath = join(directory, 'rollout-session.jsonl')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('returns a bounded tail followed by new messages from the exact file', async () => {
    await writeFile(
      transcriptPath,
      [codexMessage('one', 'first'), codexMessage('two', 'second'), codexMessage('three', 'third')]
        .join('\n')
        .concat('\n')
    )

    const initial = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      limit: 2
    })
    expect(initial).toMatchObject({
      ok: true,
      messages: [
        { id: 'two', blocks: [{ type: 'text', text: 'second' }] },
        { id: 'three', blocks: [{ type: 'text', text: 'third' }] }
      ],
      limited: true
    })
    if (!initial.ok) {
      throw new Error('Expected the initial transcript page')
    }

    await appendFile(transcriptPath, `{malformed}\n${codexMessage('four', 'fourth')}\n`)
    const appended = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      offset: initial.nextOffset,
      expectedSourceFingerprint: initial.sourceFingerprint,
      expectedBoundaryCheckpoint: initial.boundaryCheckpoint,
      limit: 2
    })

    expect(appended).toMatchObject({
      ok: true,
      messages: [{ id: 'four', blocks: [{ type: 'text', text: 'fourth' }] }],
      limited: false,
      warnings: ['1 malformed transcript record(s) were skipped.']
    })
  })

  it('pages forward through every record when a page fills before the end of the file', async () => {
    await writeFile(transcriptPath, `${codexMessage('zero', 'start')}\n`)
    const initial = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      limit: 1
    })
    if (!initial.ok) {
      throw new Error('Expected the initial transcript page')
    }
    const ids = Array.from({ length: 7 }, (_, index) => `forward-${index}`)
    await appendFile(transcriptPath, ids.map((id) => `${codexMessage(id, id)}\n`).join(''))

    const seen: string[] = []
    let cursor = initial
    for (let page = 0; page < ids.length; page++) {
      const next = await readWorkerTranscript({
        agent: 'codex',
        sessionId: 'session-exact',
        transcriptPath,
        offset: cursor.nextOffset,
        expectedSourceFingerprint: cursor.sourceFingerprint,
        expectedBoundaryCheckpoint: cursor.boundaryCheckpoint,
        limit: 2
      })
      if (!next.ok) {
        throw new Error(`Expected forward page ${page}, got ${next.reason}`)
      }
      seen.push(...next.messages.map((message) => message.id))
      cursor = next
      if (!next.limited) {
        break
      }
    }

    expect(seen).toEqual(ids)
  })

  it.each([
    ['equal-size', 0],
    ['larger', 64]
  ])('rejects a same-inode truncate/regrow at %s', async (_label, extraBytes) => {
    await writeFile(
      transcriptPath,
      `${codexMessage('one', 'original transcript with enough padding for equal-size rewrite')}\n`
    )
    const initial = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      limit: 10
    })
    if (!initial.ok) {
      throw new Error('Expected the original transcript page')
    }
    const before = await stat(transcriptPath, { bigint: true })
    const replacementLine = `${codexMessage('other', 'unrelated rewrite')}\n`
    const replacement = replacementLine.padEnd(initial.nextOffset + extraBytes, ' ')

    await writeFile(transcriptPath, replacement)

    const after = await stat(transcriptPath, { bigint: true })
    expect(after.ino).toBe(before.ino)
    expect(after.dev).toBe(before.dev)
    expect(Number(after.size)).toBeGreaterThanOrEqual(initial.nextOffset)
    await expect(
      readWorkerTranscript({
        agent: 'codex',
        sessionId: 'session-exact',
        transcriptPath,
        offset: initial.nextOffset,
        expectedSourceFingerprint: initial.sourceFingerprint,
        expectedBoundaryCheckpoint: initial.boundaryCheckpoint,
        limit: 10
      })
    ).resolves.toEqual({ ok: false, reason: 'source_changed', warnings: [] })
  })

  it('makes file-position fallback IDs opaque', async () => {
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        timestamp: '2026-07-24T12:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'no provider id' }
      })}\n`
    )

    const result = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      limit: 2
    })

    expect(result).toMatchObject({
      ok: true,
      messages: [{ id: expect.stringMatching(/^worker-message-/) }],
      warnings: ['Transcript-backed message identifiers were made opaque.']
    })
    expect(result.ok && JSON.stringify(result.messages)).not.toContain(transcriptPath)
  })

  it('advances past a record larger than the forward scan window', async () => {
    await writeFile(transcriptPath, 'x'.repeat(8 * 1024 * 1024 + 10))

    const oversized = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      offset: 0,
      limit: 2
    })
    expect(oversized).toMatchObject({
      ok: true,
      messages: [],
      limited: true,
      warnings: expect.arrayContaining([
        '1 oversized transcript record(s) were skipped.',
        'Transcript scanning stopped at the bounded byte limit; continue with the cursor.'
      ])
    })
    if (!oversized.ok) {
      throw new Error('Expected the oversized transcript page')
    }
    expect(oversized.nextOffset).toBe(8 * 1024 * 1024)

    await appendFile(transcriptPath, `\n${codexMessage('after', 'after oversized')}\n`)
    const continued = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'session-exact',
      transcriptPath,
      offset: oversized.nextOffset,
      expectedSourceFingerprint: oversized.sourceFingerprint,
      expectedBoundaryCheckpoint: oversized.boundaryCheckpoint,
      limit: 2
    })

    expect(continued).toMatchObject({
      ok: true,
      messages: [{ id: 'after', blocks: [{ type: 'text', text: 'after oversized' }] }],
      limited: false
    })
  })

  it('carries the newest turn marker of a Claude transcript, completed only by an explicit end', async () => {
    const claudePath = join(directory, 'session-a.jsonl')
    const row = (record: Record<string, unknown>) =>
      `${JSON.stringify({ sessionId: 'session-a', timestamp: '2026-11-15T12:00:00.000Z', ...record })}\n`
    const read = () =>
      readWorkerTranscript({ agent: 'claude', sessionId: 'session-a', transcriptPath: claudePath })
    await writeFile(
      claudePath,
      row({
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: [{ type: 'text', text: 'return FINISHED' }] }
      })
    )
    expect(await read()).toMatchObject({ ok: true, turn: { state: 'working' } })

    const assistant = (uuid: string, stopReason?: string) =>
      row({
        type: 'assistant',
        uuid,
        message: {
          id: uuid,
          role: 'assistant',
          content: [{ type: 'text', text: 'FINISHED' }],
          ...(stopReason ? { stop_reason: stopReason } : {})
        }
      })
    await appendFile(claudePath, assistant('u2'))
    expect(await read()).not.toHaveProperty('turn')
    await appendFile(claudePath, assistant('u3', 'end_turn'))
    expect(await read()).toMatchObject({ ok: true, turn: { state: 'completed' } })
  })

  it('carries whether a Codex rollout completed its task', async () => {
    const event = (payload: Record<string, unknown>) =>
      `${JSON.stringify({ timestamp: '2026-07-24T12:00:00.000Z', type: 'event_msg', payload })}\n`
    const read = () =>
      readWorkerTranscript({ agent: 'codex', sessionId: 'session-exact', transcriptPath })
    await writeFile(
      transcriptPath,
      event({ type: 'task_started', turn_id: 't1' }) +
        event({ type: 'user_message', message: 'return FINISHED' })
    )
    expect(await read()).toMatchObject({ ok: true, turn: { state: 'working' } })
    await appendFile(
      transcriptPath,
      `${codexMessage('reply', 'FINISHED')}\n${event({ type: 'task_complete', turn_id: 't1' })}`
    )
    expect(await read()).toMatchObject({ ok: true, turn: { state: 'completed' } })
  })

  describe('pages of Chinese text larger than the response budget', () => {
    // Six 1,200-character blocks of 3-byte characters: about 21 KB per message after bounds,
    // so 40 of them exceed the 512 KiB response budget.
    const bigMessage = (index: number) =>
      `${JSON.stringify({
        type: 'assistant',
        sessionId: 'session-cjk',
        uuid: `cjk-${index}`,
        timestamp: '2026-11-21T12:00:00.000Z',
        message: {
          id: `cjk-${index}`,
          role: 'assistant',
          content: Array.from({ length: 6 }, () => ({
            type: 'text',
            text: `MSG${index} ${'研发测试'.repeat(300)}`
          }))
        }
      })}\n`
    const labels = (messages: { blocks: { type: string; text?: string }[] }[]) =>
      messages.map((message) => {
        const block = message.blocks[0]
        return block?.type === 'text' ? block.text?.split(' ')[0] : undefined
      })
    const all = Array.from({ length: 45 }, (_, index) => `MSG${index}`)
    let claudePath: string
    const read = (cursor?: {
      nextOffset: number
      sourceFingerprint: string
      boundaryCheckpoint: string
    }) =>
      readWorkerTranscript({
        agent: 'claude',
        sessionId: 'session-cjk',
        transcriptPath: claudePath,
        ...(cursor
          ? {
              offset: cursor.nextOffset,
              expectedSourceFingerprint: cursor.sourceFingerprint,
              expectedBoundaryCheckpoint: cursor.boundaryCheckpoint
            }
          : {})
      })

    beforeEach(() => {
      claudePath = join(directory, 'session-cjk.jsonl')
    })

    it('serves the newest messages on the first page', async () => {
      await writeFile(claudePath, all.map((_, index) => bigMessage(index)).join(''))

      const first = await read()
      if (!first.ok) {
        throw new Error(`Expected the first page, got ${first.reason}`)
      }
      const served = labels(first.messages)
      expect(served.at(-1)).toBe('MSG44')
      expect(served.length).toBeLessThan(40)
      expect(served).toEqual(all.slice(all.length - served.length))
      expect(first.warnings).toContain('Transcript response was clipped to the wire-size limit.')
      expect(first.clipping).toContain('transcript_payload')
    })

    it('resumes a forward page after its last served message, skipping none', async () => {
      await writeFile(claudePath, bigMessage(-1))
      const first = await read()
      if (!first.ok) {
        throw new Error(`Expected the first page, got ${first.reason}`)
      }
      await appendFile(claudePath, all.map((_, index) => bigMessage(index)).join(''))

      const seen: (string | undefined)[] = []
      let cursor = first
      for (let page = 0; page < all.length; page++) {
        const next = await read(cursor)
        if (!next.ok) {
          throw new Error(`Expected forward page ${page}, got ${next.reason}`)
        }
        seen.push(...labels(next.messages))
        cursor = next
        if (next.messages.length === 0) {
          break
        }
      }

      expect(seen).toEqual(all)
    })
  })
})
