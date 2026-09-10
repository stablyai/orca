import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TRANSCRIPT_TAIL_READ_LIMIT_BYTES } from './claude-transcript-tail-scan'
import {
  claudeConversationNameReporterDeps,
  readClaudeTranscriptConversationName,
  reportPersistedClaudeConversationName
} from './claude-transcript-conversation-name'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-title-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function transcript(lines: readonly unknown[]): Promise<string> {
  const path = join(root, 'session-1.jsonl')
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8')
  return path
}

describe('readClaudeTranscriptConversationName', () => {
  it('reads the generated title Claude persisted', async () => {
    const path = await transcript([
      { type: 'user', sessionId: 'session-1' },
      { type: 'ai-title', aiTitle: 'Lease probe flake', sessionId: 'session-1' }
    ])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({
      kind: 'named',
      title: 'Lease probe flake'
    })
  })

  it('takes the latest generated title when Claude revised it', async () => {
    const path = await transcript([
      { type: 'ai-title', aiTitle: 'First guess', sessionId: 'session-1' },
      { type: 'ai-title', aiTitle: 'Lease probe flake', sessionId: 'session-1' }
    ])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({
      kind: 'named',
      title: 'Lease probe flake'
    })
  })

  it('prefers a name the user set over the generated one', async () => {
    const path = await transcript([
      { type: 'ai-title', aiTitle: 'Lease probe flake', sessionId: 'session-1' },
      { type: 'custom-title', customTitle: 'My own name', sessionId: 'session-1' }
    ])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({
      kind: 'named',
      title: 'My own name'
    })
  })

  it('reports null for a transcript that carries no name', async () => {
    const path = await transcript([{ type: 'user', sessionId: 'session-1' }])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({
      kind: 'unknown'
    })
  })
})

describe('readClaudeTranscriptConversationName clearing', () => {
  // These write REAL transcript records. The reporter tests below stub this
  // reader, so they cannot see anything it decides — including whether an
  // emptied custom title should fall back or wipe the name.
  it('falls back to the generated title when the user empties their own', async () => {
    const path = await transcript([
      { type: 'ai-title', aiTitle: 'Lease probe flake', sessionId: 'session-1' },
      { type: 'custom-title', customTitle: 'My own name', sessionId: 'session-1' },
      { type: 'custom-title', customTitle: '', sessionId: 'session-1' }
    ])

    // The CLI still shows the ai-title here; reporting `cleared` would wipe a
    // name the user can see.
    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({
      kind: 'named',
      title: 'Lease probe flake'
    })
  })

  it('reports cleared only when nothing remains to fall back to', async () => {
    const path = await transcript([
      { type: 'custom-title', customTitle: 'My own name', sessionId: 'session-1' },
      { type: 'custom-title', customTitle: '', sessionId: 'session-1' }
    ])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({
      kind: 'cleared'
    })
  })

  it('finds a generated fallback beyond the tail window', async () => {
    // Title precedence can depend on a record anywhere in the transcript.
    const filler = `${'x'.repeat(1023)}\n`
    const path = join(root, 'huge.jsonl')
    await writeFile(
      path,
      [
        `${JSON.stringify({ type: 'ai-title', aiTitle: 'Lease probe flake', sessionId: 's' })}\n`,
        filler.repeat(Math.ceil(TRANSCRIPT_TAIL_READ_LIMIT_BYTES / 1024) + 8),
        `${JSON.stringify({ type: 'custom-title', customTitle: '', sessionId: 's' })}\n`
      ].join(''),
      'utf8'
    )

    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({
      kind: 'named',
      title: 'Lease probe flake'
    })
  })

  it.each([
    ['an object', { title: 'nested' }],
    ['a number', 12],
    ['a boolean', true]
  ])('refuses to coerce %s into a generated title', async (_label, aiTitle) => {
    const path = await transcript([
      { type: 'user', sessionId: 'session-1' },
      { type: 'ai-title', aiTitle, sessionId: 'session-1' }
    ])

    // `String({})` is `[object Object]`, which survives every downstream check
    // and would be persisted as the tab's label.
    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({ kind: 'unknown' })
  })

  it.each([
    ['an absent field', { type: 'custom-title', sessionId: 'session-1' }],
    ['a null field', { type: 'custom-title', customTitle: null, sessionId: 'session-1' }],
    ['a renamed field', { type: 'custom-title', title: '', sessionId: 'session-1' }]
  ])('refuses to read %s as a deliberate clear', async (_label, record) => {
    const path = await transcript([
      { type: 'ai-title', aiTitle: 'Lease probe flake', sessionId: 'session-1' },
      record
    ])

    // Fails closed, like isCodexThreadReadablyUnnamed: a shape this build cannot
    // read is not evidence the user removed anything.
    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({
      kind: 'named',
      title: 'Lease probe flake'
    })
  })

  it('reports unknown, not cleared, for a tail with no title record at all', async () => {
    const path = await transcript([{ type: 'user', sessionId: 'session-1' }])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({ kind: 'unknown' })
  })

  it('still prefers a custom title the user actually set', async () => {
    const path = await transcript([
      { type: 'ai-title', aiTitle: 'Lease probe flake', sessionId: 'session-1' },
      { type: 'custom-title', customTitle: 'My own name', sessionId: 'session-1' }
    ])

    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({
      kind: 'named',
      title: 'My own name'
    })
  })
})

describe('reportPersistedClaudeConversationName', () => {
  const session = { providerSessionId: 'provider-1', claudeConfigDir: '/home/dev/.claude' }

  it('hands on the name the transcript held', async () => {
    const onConversationName = vi.fn()
    const readTranscriptConversationName = vi.fn(async () => ({
      kind: 'named' as const,
      title: 'Lease probe flake'
    }))

    reportPersistedClaudeConversationName('session-1', session, {
      readTranscriptConversationName,
      onConversationName
    })
    await vi.waitFor(() => expect(onConversationName).toHaveBeenCalled())

    // Asserted by shape, not against `session`: finding a name marks that object
    // as already named, so comparing to it would compare with the mutation.
    expect(readTranscriptConversationName).toHaveBeenCalledWith({
      providerSessionId: 'provider-1',
      claudeConfigDir: '/home/dev/.claude'
    })
    expect(onConversationName).toHaveBeenCalledExactlyOnceWith('session-1', 'Lease probe flake')
  })

  it('reports nothing when the transcript holds no name', async () => {
    const onConversationName = vi.fn()
    const readTranscriptConversationName = vi.fn(async () => ({ kind: 'unknown' as const }))

    reportPersistedClaudeConversationName('session-1', session, {
      readTranscriptConversationName,
      onConversationName
    })
    await vi.waitFor(() => expect(readTranscriptConversationName).toHaveBeenCalled())

    expect(onConversationName).not.toHaveBeenCalled()
  })

  it('swallows an unreadable transcript rather than failing the acquisition', async () => {
    const onConversationName = vi.fn()
    const readTranscriptConversationName = vi.fn(async () => {
      throw new Error('ENOENT')
    })

    expect(() =>
      reportPersistedClaudeConversationName('session-1', session, {
        readTranscriptConversationName,
        onConversationName
      })
    ).not.toThrow()
    await vi.waitFor(() => expect(readTranscriptConversationName).toHaveBeenCalled())

    expect(onConversationName).not.toHaveBeenCalled()
  })

  it('marks the session named, so nothing generates a second title for it', async () => {
    const live = { ...session, namingAttempted: false }

    reportPersistedClaudeConversationName('session-1', live, {
      readTranscriptConversationName: vi.fn(async () => ({
        kind: 'named' as const,
        title: 'Lease probe flake'
      })),
      onConversationName: vi.fn()
    })
    await vi.waitFor(() => expect(live.namingAttempted).toBe(true))
  })

  it('leaves the session generatable when the transcript holds no name', async () => {
    const live = { ...session, namingAttempted: false }
    const readTranscriptConversationName = vi.fn(async () => ({ kind: 'unknown' as const }))

    reportPersistedClaudeConversationName('session-1', live, {
      readTranscriptConversationName,
      onConversationName: vi.fn()
    })
    await vi.waitFor(() => expect(readTranscriptConversationName).toHaveBeenCalled())

    expect(live.namingAttempted).toBe(false)
  })

  it('reports a name the user deleted in the CLI as cleared', async () => {
    const onConversationNameCleared = vi.fn()

    reportPersistedClaudeConversationName(
      'session-1',
      { ...session },
      {
        readTranscriptConversationName: vi.fn(async () => ({ kind: 'cleared' as const })),
        onConversationName: vi.fn(),
        onConversationNameCleared
      }
    )
    await vi.waitFor(() => expect(onConversationNameCleared).toHaveBeenCalledWith('session-1'))
  })

  it('does NOT clear merely because the bounded tail held no title record', async () => {
    const onConversationNameCleared = vi.fn()
    const readTranscriptConversationName = vi.fn(async () => ({ kind: 'unknown' as const }))

    reportPersistedClaudeConversationName(
      'session-1',
      { ...session },
      {
        readTranscriptConversationName,
        onConversationName: vi.fn(),
        onConversationNameCleared
      }
    )
    await vi.waitFor(() => expect(readTranscriptConversationName).toHaveBeenCalled())

    // The scan is bounded: an older title simply is not visible from the tail,
    // which is not evidence the user removed it.
    expect(onConversationNameCleared).not.toHaveBeenCalled()
  })

  it('does nothing for a session that is not live', async () => {
    const readTranscriptConversationName = vi.fn(async () => ({
      kind: 'named' as const,
      title: 'Lease probe flake'
    }))

    reportPersistedClaudeConversationName('session-1', undefined, {
      readTranscriptConversationName,
      onConversationName: vi.fn()
    })

    expect(readTranscriptConversationName).not.toHaveBeenCalled()
  })
})

describe('claudeConversationNameReporterDeps', () => {
  it('maps the adapter’s onNamingError onto the reporter’s onError', () => {
    const onNamingError = vi.fn()

    // The adapter names this hook differently. Handing its object over whole
    // worked only by accident and would break the day it is narrowed.
    const mapped = claudeConversationNameReporterDeps({ onNamingError })
    mapped.onError?.('scope', new Error('boom'))

    expect(onNamingError).toHaveBeenCalledWith('scope', expect.any(Error))
  })

  it('carries the read and both name hooks through', () => {
    const readTranscriptConversationName = vi.fn(async () => ({ kind: 'unknown' as const }))
    const onConversationName = vi.fn()
    const onConversationNameCleared = vi.fn()

    const mapped = claudeConversationNameReporterDeps({
      readTranscriptConversationName,
      onConversationName,
      onConversationNameCleared
    })

    expect(mapped.readTranscriptConversationName).toBe(readTranscriptConversationName)
    expect(mapped.onConversationName).toBe(onConversationName)
    expect(mapped.onConversationNameCleared).toBe(onConversationNameCleared)
  })
})

describe('Claude title precedence across long transcripts', () => {
  it('keeps a manual title older than the tail window ahead of a new generated title', async () => {
    const path = await transcript([
      { type: 'custom-title', customTitle: 'My manual name' },
      { type: 'assistant', text: 'x'.repeat(TRANSCRIPT_TAIL_READ_LIMIT_BYTES + 1024) },
      { type: 'ai-title', aiTitle: 'Generated replacement' }
    ])
    await expect(readClaudeTranscriptConversationName(path)).resolves.toEqual({
      kind: 'named',
      title: 'My manual name'
    })
  })
})

describe('Claude acquisition title ordering', () => {
  it('does not publish a read superseded by another acquisition', async () => {
    let complete!: (value: { kind: 'named'; title: string }) => void
    const read = new Promise<{ kind: 'named'; title: string }>((resolve) => {
      complete = resolve
    })
    let current = true
    const onConversationName = vi.fn()
    const result = reportPersistedClaudeConversationName(
      'session-1',
      {
        providerSessionId: 'provider-1',
        claudeConfigDir: '/tmp'
      },
      { readTranscriptConversationName: () => read, onConversationName },
      () => current
    )
    current = false
    complete({ kind: 'named', title: 'Old title' })
    await expect(result).resolves.toEqual({ kind: 'unknown' })
    expect(onConversationName).not.toHaveBeenCalled()
  })
})
