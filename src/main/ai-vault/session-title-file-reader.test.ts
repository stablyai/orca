import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const parseAgentSessionFileCached = vi.hoisted(() => vi.fn())

vi.mock('./session-scanner-parse-cache', () => ({ parseAgentSessionFileCached }))

const { readAiVaultSessionTitlesFromFiles } = await import('./session-title-file-reader')
const { resolveHostReadableAiVaultTitleRequests } = await import('./session-title-request-paths')

let temporaryRoots: string[] = []

beforeEach(() => {
  parseAgentSessionFileCached.mockReset()
})

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

async function transcriptPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-title-'))
  temporaryRoots.push(root)
  const path = join(root, 'session.jsonl')
  await writeFile(path, '{}\n')
  return path
}

describe('readAiVaultSessionTitlesFromFiles', () => {
  it('probes exact transcript paths in the background-scanner layer', async () => {
    const path = await transcriptPath()

    await expect(
      resolveHostReadableAiVaultTitleRequests([
        { agent: 'codex', sessionId: 'present', transcriptPath: path },
        { agent: 'claude', sessionId: 'missing', transcriptPath: `${path}.missing` }
      ])
    ).resolves.toEqual([
      { agent: 'codex', sessionId: 'present', transcriptPath: path },
      { agent: 'claude', sessionId: 'missing' }
    ])
  })

  it('reads only the exact requested transcript and validates its identity', async () => {
    const path = await transcriptPath()
    parseAgentSessionFileCached.mockResolvedValue({
      agent: 'codex',
      sessionId: 'session-1',
      title: '  Exact title  '
    })

    await expect(
      readAiVaultSessionTitlesFromFiles([
        { agent: 'codex', sessionId: 'session-1', transcriptPath: path }
      ])
    ).resolves.toEqual({
      titles: [{ agent: 'codex', sessionId: 'session-1', title: 'Exact title' }]
    })
    expect(parseAgentSessionFileCached).toHaveBeenCalledTimes(1)
    expect(parseAgentSessionFileCached.mock.calls[0]?.[0]).toMatchObject({
      agent: 'codex',
      file: { path }
    })
  })

  it('rejects a transcript whose parsed identity does not match the request', async () => {
    const path = await transcriptPath()
    parseAgentSessionFileCached.mockResolvedValue({
      agent: 'codex',
      sessionId: 'different-session',
      title: 'Wrong title'
    })

    await expect(
      readAiVaultSessionTitlesFromFiles([
        { agent: 'codex', sessionId: 'session-1', transcriptPath: path }
      ])
    ).resolves.toEqual({ titles: [] })
  })

  it('uses the bounded worker index when no transcript path is available', async () => {
    const cached = { agent: 'claude' as const, sessionId: 'session-1', title: 'Cached title' }
    const cache = { get: vi.fn(() => cached), set: vi.fn() }

    await expect(
      readAiVaultSessionTitlesFromFiles([{ agent: 'claude', sessionId: 'session-1' }], {
        cache
      })
    ).resolves.toEqual({ titles: [cached] })
    expect(parseAgentSessionFileCached).not.toHaveBeenCalled()
    expect(cache.set).not.toHaveBeenCalled()
  })

  it('caps exact transcript reads at 64 identities', async () => {
    const path = await transcriptPath()
    parseAgentSessionFileCached.mockResolvedValue({
      agent: 'codex',
      sessionId: 'session-0',
      title: 'Title'
    })

    await readAiVaultSessionTitlesFromFiles(
      Array.from({ length: 65 }, (_, index) => ({
        agent: 'codex' as const,
        sessionId: `session-${index}`,
        transcriptPath: path
      }))
    )

    expect(parseAgentSessionFileCached).toHaveBeenCalledTimes(64)
  })
})
