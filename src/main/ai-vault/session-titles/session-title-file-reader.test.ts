import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as transcriptFs from '../../native-chat/wsl-transcript-fs-access'

const parseAgentSessionFileCached = vi.hoisted(() => vi.fn())

vi.mock('../parse-cache/session-scanner-parse-cache', () => ({ parseAgentSessionFileCached }))

const { readAiVaultSessionTitlesFromFiles } = await import('./session-title-file-reader')
const { resolveHostReadableAiVaultTitleRequests } = await import('./session-title-request-paths')

let temporaryRoots: string[] = []

beforeEach(() => {
  parseAgentSessionFileCached.mockReset()
})

afterEach(async () => {
  vi.restoreAllMocks()
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

    const controller = new AbortController()
    await expect(
      readAiVaultSessionTitlesFromFiles(
        [{ agent: 'codex', sessionId: 'session-1', transcriptPath: path }],
        { signal: controller.signal }
      )
    ).resolves.toEqual({
      titles: [{ agent: 'codex', sessionId: 'session-1', title: 'Exact title' }]
    })
    expect(parseAgentSessionFileCached.mock.calls[0]?.[4]).toBe(controller.signal)
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

  it('resolves one home directly from its index without requiring rollout reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-title-index-direct-'))
    temporaryRoots.push(root)
    await mkdir(join(root, 'sessions'))
    await writeFile(
      join(root, 'session_index.jsonl'),
      '{"id":"named","thread_name":"Indexed name"}\n'
    )
    const readStat = vi.spyOn(transcriptFs, 'wslGatedStat')
    const result = await readAiVaultSessionTitlesFromFiles(
      Array.from({ length: 9 }, () => ({
        agent: 'codex' as const,
        sessionId: 'named',
        transcriptPath: join(root, 'sessions', 'missing-rollout.jsonl')
      }))
    )
    expect(result.titles).toEqual(
      Array.from({ length: 9 }, () => ({
        agent: 'codex',
        sessionId: 'named',
        title: 'Indexed name'
      }))
    )
    expect(
      readStat.mock.calls.filter(([path]) => path === join(root, 'session_index.jsonl'))
    ).toHaveLength(1)
    expect(parseAgentSessionFileCached).not.toHaveBeenCalled()
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
