import { describe, expect, it, vi } from 'vitest'
import { MAX_FILE_RANGE_READ_BYTES } from '../../../shared/file-range-read'
import type { IFilesystemProvider } from '../../providers/types'
import { sshFileStreamReadCap } from '../../ssh/ssh-file-stream-read-cap'
import { readWorkerTranscript } from './worker-transcript-read'
import { MAX_REMOTE_TRANSCRIPT_SCAN_BYTES } from './worker-transcript-remote-read'

function codexMessage(id: string, text: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      type: 'event_msg',
      payload: { id, type: 'agent_message', message: text }
    })}\n`
  )
}

function fileStat(readContents: () => Buffer, readIdentity: () => number = () => 1) {
  return {
    size: readContents().length,
    type: 'file' as const,
    mtime: 0,
    mtimeMs: 0,
    dev: 7,
    ino: readIdentity()
  }
}

function rangedProvider(
  readContents: () => Buffer,
  readIdentity?: () => number
): {
  provider: IFilesystemProvider
  readFile: ReturnType<typeof vi.fn>
  readFileRange: ReturnType<typeof vi.fn>
} {
  const readFile = vi.fn(async () => {
    throw new Error('Whole-file reads must not serve a ranged transcript')
  })
  const readFileRange = vi.fn(async (_path: string, position: number, length: number) => {
    const bytes = readContents().subarray(position, position + length)
    return { bytes, bytesRead: bytes.length }
  })
  return {
    provider: {
      readFile,
      readFileRange,
      supportsFileRangeRead: vi.fn(async () => true),
      stat: vi.fn(async () => fileStat(readContents, readIdentity))
    } as unknown as IFilesystemProvider,
    readFile,
    readFileRange
  }
}

function preRangeProvider(
  readContents: () => Buffer,
  readIdentity?: () => number
): IFilesystemProvider {
  return {
    readFile: vi.fn(async () => ({ content: readContents().toString('utf8'), isBinary: false })),
    readFileRange: vi.fn(),
    supportsFileRangeRead: vi.fn(async () => false),
    stat: vi.fn(async () => fileStat(readContents, readIdentity))
  } as unknown as IFilesystemProvider
}

describe('remote worker transcript reads', () => {
  it('reports a missing attested path separately from remote capability loss', async () => {
    const result = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'missing-path-session',
      filesystemProvider: preRangeProvider(() => Buffer.from(''))
    })

    expect(result).toEqual({ ok: false, reason: 'transcript_missing', warnings: [] })
  })

  it.each([
    ['ranged', (readContents: () => Buffer) => rangedProvider(readContents).provider],
    ['pre-range', preRangeProvider]
  ])(
    'holds a split EOF record at its start and emits it once after append on a %s host',
    async (_providerKind, createProvider) => {
      const first = codexMessage('first', 'complete before split')
      const splitRecord = codexMessage('split', 'completed by second append')
      const splitAt = Math.floor(splitRecord.length / 2)
      let contents = Buffer.concat([first, splitRecord.subarray(0, splitAt)])
      const provider = createProvider(() => contents)
      const transcriptPath = '/remote/split-append.jsonl'

      const initial = await readWorkerTranscript({
        agent: 'codex',
        sessionId: 'split-session',
        transcriptPath,
        filesystemProvider: provider,
        limit: 10
      })

      expect(initial).toMatchObject({
        ok: true,
        messages: [{ id: 'first', blocks: [{ type: 'text', text: 'complete before split' }] }],
        nextOffset: first.length,
        limited: false,
        warnings: []
      })
      if (!initial.ok) {
        throw new Error('Expected an initial split transcript page')
      }

      contents = Buffer.concat([contents, splitRecord.subarray(splitAt)])
      const completed = await readWorkerTranscript({
        agent: 'codex',
        sessionId: 'split-session',
        transcriptPath,
        filesystemProvider: provider,
        offset: initial.nextOffset,
        expectedSourceFingerprint: initial.sourceFingerprint,
        expectedBoundaryCheckpoint: initial.boundaryCheckpoint,
        limit: 10
      })
      expect(completed).toMatchObject({
        ok: true,
        messages: [{ id: 'split', blocks: [{ type: 'text', text: 'completed by second append' }] }],
        nextOffset: contents.length,
        limited: false
      })
      if (!completed.ok) {
        throw new Error('Expected the completed split transcript page')
      }

      await expect(
        readWorkerTranscript({
          agent: 'codex',
          sessionId: 'split-session',
          transcriptPath,
          filesystemProvider: provider,
          offset: completed.nextOffset,
          expectedSourceFingerprint: completed.sourceFingerprint,
          expectedBoundaryCheckpoint: completed.boundaryCheckpoint,
          limit: 10
        })
      ).resolves.toMatchObject({ ok: true, messages: [], nextOffset: contents.length })
    }
  )

  it('returns and redacts the newest bounded page from an append-only transcript over 8 MiB', async () => {
    const capability = `dcap_${'A'.repeat(43)}`
    let contents = Buffer.concat([
      Buffer.alloc(MAX_REMOTE_TRANSCRIPT_SCAN_BYTES + 128, 0x78),
      Buffer.from('\n'),
      codexMessage('latest', `newest output ${capability}`)
    ])
    const { provider, readFile, readFileRange } = rangedProvider(() => contents)
    const transcriptPath = '/remote/home/ada/.codex/sessions/rollout.jsonl'

    const initial = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'remote-session',
      transcriptPath,
      filesystemProvider: provider,
      limit: 2
    })

    expect(initial).toMatchObject({
      ok: true,
      messages: [
        {
          id: 'latest',
          blocks: [{ type: 'text', text: 'newest output [dispatch capability redacted]' }]
        }
      ],
      nextOffset: contents.length,
      limited: true,
      warnings: expect.arrayContaining([
        'Dispatch capability tokens were redacted from transcript output.',
        'Older transcript records were clipped by the remote scan limit and are not pageable through this EOF cursor; the cursor only follows records appended after this read.'
      ])
    })
    expect(readFile).not.toHaveBeenCalled()
    expect(readFileRange.mock.calls.every((call) => call[2] <= MAX_FILE_RANGE_READ_BYTES)).toBe(
      true
    )
    expect(readFileRange.mock.calls.reduce((sum, call) => sum + call[2], 0)).toBeLessThanOrEqual(
      MAX_REMOTE_TRANSCRIPT_SCAN_BYTES + 128
    )
    expect(JSON.stringify(initial)).not.toContain(capability)
    if (!initial.ok) {
      throw new Error('Expected an initial transcript page')
    }
    expect(initial.warnings.join(' ')).not.toContain('continue with the cursor')

    contents = Buffer.concat([contents, codexMessage('appended', 'arrived after the first read')])
    await expect(
      readWorkerTranscript({
        agent: 'codex',
        sessionId: 'remote-session',
        transcriptPath,
        filesystemProvider: provider,
        offset: initial.nextOffset,
        expectedSourceFingerprint: initial.sourceFingerprint,
        expectedBoundaryCheckpoint: initial.boundaryCheckpoint,
        limit: 2
      })
    ).resolves.toMatchObject({
      ok: true,
      messages: [
        { id: 'appended', blocks: [{ type: 'text', text: 'arrived after the first read' }] }
      ],
      nextOffset: contents.length,
      limited: false
    })
  })

  it('keeps the bounded whole-file fallback for an older SSH host', async () => {
    const contents = codexMessage('legacy', 'small legacy transcript')
    const readFile = vi.fn(async () => ({ content: contents.toString('utf8'), isBinary: false }))
    const readFileRange = vi.fn()
    const provider = {
      readFile,
      readFileRange,
      supportsFileRangeRead: vi.fn(async () => false),
      stat: vi.fn(async () => fileStat(() => contents))
    } as unknown as IFilesystemProvider

    await expect(
      readWorkerTranscript({
        agent: 'codex',
        sessionId: 'legacy-session',
        transcriptPath: '/remote/legacy.jsonl',
        filesystemProvider: provider
      })
    ).resolves.toMatchObject({
      ok: true,
      messages: [{ id: 'legacy', blocks: [{ type: 'text', text: 'small legacy transcript' }] }]
    })
    expect(readFile).toHaveBeenCalledWith('/remote/legacy.jsonl', {
      maxTextBytes: sshFileStreamReadCap(false)
    })
    expect(readFileRange).not.toHaveBeenCalled()
  })

  it('tails above the scan cap on a pre-range host and follows its EOF cursor', async () => {
    let contents = Buffer.concat([
      Buffer.alloc(MAX_REMOTE_TRANSCRIPT_SCAN_BYTES + 128, 0x78),
      Buffer.from('\n'),
      codexMessage('legacy-tail', 'newest legacy output')
    ])
    const readFile = vi.fn(async (_path: string, limits?: { maxTextBytes?: number }) => {
      if (contents.length > (limits?.maxTextBytes ?? 0)) {
        throw new Error('Reported totalSize exceeds client cap')
      }
      return { content: contents.toString('utf8'), isBinary: false }
    })
    const provider = {
      readFile,
      readFileRange: vi.fn(),
      supportsFileRangeRead: vi.fn(async () => false),
      stat: vi.fn(async () => fileStat(() => contents))
    } as unknown as IFilesystemProvider
    const transcriptPath = '/remote/legacy-large.jsonl'

    const initial = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'legacy-large-session',
      transcriptPath,
      filesystemProvider: provider,
      limit: 2
    })

    expect(initial).toMatchObject({
      ok: true,
      messages: [{ id: 'legacy-tail', blocks: [{ type: 'text', text: 'newest legacy output' }] }],
      nextOffset: contents.length,
      limited: true,
      warnings: expect.arrayContaining([
        'Older transcript records were clipped by the remote scan limit and are not pageable through this EOF cursor; the cursor only follows records appended after this read.'
      ])
    })
    if (!initial.ok) {
      throw new Error('Expected an initial legacy transcript page')
    }

    contents = Buffer.concat([contents, codexMessage('legacy-appended', 'followed from cursor')])
    await expect(
      readWorkerTranscript({
        agent: 'codex',
        sessionId: 'legacy-large-session',
        transcriptPath,
        filesystemProvider: provider,
        offset: initial.nextOffset,
        expectedSourceFingerprint: initial.sourceFingerprint,
        expectedBoundaryCheckpoint: initial.boundaryCheckpoint,
        limit: 2
      })
    ).resolves.toMatchObject({
      ok: true,
      messages: [
        { id: 'legacy-appended', blocks: [{ type: 'text', text: 'followed from cursor' }] }
      ],
      nextOffset: contents.length,
      limited: false
    })
    expect(readFile).toHaveBeenLastCalledWith(transcriptPath, {
      maxTextBytes: sshFileStreamReadCap(false)
    })
  })

  it.each([
    ['equal-size', 0],
    ['larger', 64]
  ])('rejects a same-identity ranged truncate/regrow at %s', async (_label, extraBytes) => {
    let contents = codexMessage(
      'first',
      'original transcript with enough padding for equal-size rewrite'
    )
    const { provider } = rangedProvider(() => contents)
    const transcriptPath = '/remote/replaced.jsonl'
    const initial = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'replacement-session',
      transcriptPath,
      filesystemProvider: provider,
      limit: 10
    })
    if (!initial.ok) {
      throw new Error('Expected the original remote transcript')
    }

    const replacement = codexMessage('unrelated', 'replacement content')
    contents = Buffer.concat([
      replacement,
      Buffer.alloc(Math.max(0, initial.nextOffset + extraBytes - replacement.length), 0x20)
    ])
    const replaced = await readWorkerTranscript({
      agent: 'codex',
      sessionId: 'replacement-session',
      transcriptPath,
      filesystemProvider: provider,
      offset: initial.nextOffset,
      expectedSourceFingerprint: initial.sourceFingerprint,
      expectedBoundaryCheckpoint: initial.boundaryCheckpoint,
      limit: 10
    })

    expect(replaced).toEqual({ ok: false, reason: 'source_changed', warnings: [] })
  })

  it('degrades when a remote host cannot prove stable file identity', async () => {
    const contents = codexMessage('legacy', 'identity unavailable')
    const provider = {
      readFile: vi.fn(async () => ({ content: contents.toString('utf8'), isBinary: false })),
      readFileRange: vi.fn(),
      supportsFileRangeRead: vi.fn(async () => false),
      stat: vi.fn(async () => ({ size: contents.length, type: 'file' as const, mtime: 0 }))
    } as unknown as IFilesystemProvider

    await expect(
      readWorkerTranscript({
        agent: 'codex',
        sessionId: 'legacy-no-identity',
        transcriptPath: '/remote/legacy-no-identity.jsonl',
        filesystemProvider: provider
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'remote_capability_unavailable',
      warnings: []
    })
  })
})
