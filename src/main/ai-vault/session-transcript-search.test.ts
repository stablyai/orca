import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { searchAiVaultTranscripts } from './session-transcript-search'

const tempRoots: string[] = []

afterEach(async () => {
  // Best-effort cleanup; tests are sandboxed under mkdtemp.
  const { rm } = await import('node:fs/promises')
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeTranscriptRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `orca-transcript-search-${name}-`))
  tempRoots.push(root)
  return root
}

describe('searchAiVaultTranscripts', () => {
  it('finds matches in the transcript body and returns a cleaned snippet', async () => {
    const root = await makeTranscriptRoot('basic')
    const filePath = join(root, 'session.jsonl')
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the login bug' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'The FLAKY TEST was caused by a race in setup.' }
        })
      ].join('\n')
    )
    const result = await searchAiVaultTranscripts({
      query: 'flaky test',
      requests: [{ agent: 'claude', filePath, sessionId: 's1' }]
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({
      agent: 'claude',
      sessionId: 's1',
      matchCount: 1
    })
    expect(result.matches[0].snippet).toContain('FLAKY TEST was caused')
    expect(result.issues).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('finds a match on the first line of a small single-line transcript', async () => {
    // Regression: a whole-file window must not drop line 1 as a seek fragment.
    const root = await makeTranscriptRoot('single-line')
    const filePath = join(root, 'only.jsonl')
    await writeFile(filePath, JSON.stringify({ text: 'the flaky checkout step was retried' }))
    const result = await searchAiVaultTranscripts({
      query: 'flaky checkout',
      requests: [{ agent: 'claude', filePath }]
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].matchCount).toBe(1)
  })

  it('skips missing transcript files silently instead of raising issues', async () => {
    const root = await makeTranscriptRoot('missing')
    const result = await searchAiVaultTranscripts({
      query: 'needle',
      requests: [{ agent: 'codex', filePath: join(root, 'gone.jsonl') }]
    })
    expect(result.matches).toEqual([])
    expect(result.issues).toEqual([])
  })

  it('reports unreadable targets as issues', async () => {
    const root = await makeTranscriptRoot('dir')
    const dirPath =
      (await mkdir(join(root, 'not-a-file'), { recursive: true })) ?? join(root, 'not-a-file')
    const result = await searchAiVaultTranscripts({
      query: 'needle',
      requests: [{ agent: 'claude', filePath: dirPath }]
    })
    expect(result.matches).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].agent).toBe('claude')
    expect(result.issues[0].path).toBe(dirPath)
  })

  it('returns empty for a too-short query without touching files', async () => {
    const root = await makeTranscriptRoot('short')
    const result = await searchAiVaultTranscripts({
      query: ' x ',
      requests: [{ agent: 'claude', filePath: join(root, 'a.jsonl') }]
    })
    expect(result).toEqual({ matches: [], issues: [], truncated: false })
  })

  it('prefers the tail window and still falls back to the head', async () => {
    const root = await makeTranscriptRoot('windows')
    const fillerLine = JSON.stringify({ padding: 'x'.repeat(4096) })
    const headPath = join(root, 'head-hit.jsonl')
    // A big file whose only hit sits in the head half, beyond the tail window.
    const lines: string[] = [
      JSON.stringify({ text: 'the flash attention fix lives here at the start' })
    ]
    while (lines.join('\n').length < 3 * 1024 * 1024) {
      lines.push(fillerLine)
    }
    lines.push(fillerLine)
    await writeFile(headPath, lines.join('\n'))
    const headResult = await searchAiVaultTranscripts({
      query: 'flash attention',
      requests: [{ agent: 'claude', filePath: headPath }]
    })
    expect(headResult.matches).toHaveLength(1)
    expect(headResult.matches[0].snippet).toContain('flash attention fix')

    // And a hit only inside the tail window is found directly.
    const tailPath = join(root, 'tail-hit.jsonl')
    const tailLines: string[] = [fillerLine]
    while (tailLines.join('\n').length < 3 * 1024 * 1024) {
      tailLines.push(fillerLine)
    }
    tailLines.push(JSON.stringify({ text: 'recent work: ship the kernel upgrade' }))
    await writeFile(tailPath, tailLines.join('\n'))
    const tailResult = await searchAiVaultTranscripts({
      query: 'kernel upgrade',
      requests: [{ agent: 'claude', filePath: tailPath }]
    })
    expect(tailResult.matches).toHaveLength(1)
    expect(tailResult.matches[0].snippet).toContain('ship the kernel upgrade')
  })

  it('stops early when the abort signal fires', async () => {
    const root = await makeTranscriptRoot('abort')
    const requests = Array.from({ length: 50 }, (_, i) => ({
      agent: 'claude' as const,
      filePath: join(root, `s${i}.jsonl`),
      sessionId: `s${i}`
    }))
    await Promise.all(
      requests.map((request) => writeFile(request.filePath, 'needle in transcript\n'.repeat(500)))
    )
    const controller = new AbortController()
    controller.abort()
    const result = await searchAiVaultTranscripts(
      { query: 'needle', requests },
      { signal: controller.signal }
    )
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('honors a tiny time budget by reporting truncation on a large sweep', async () => {
    const root = await makeTranscriptRoot('budget')
    const requests = Array.from({ length: 12 }, (_, i) => ({
      agent: 'claude' as const,
      filePath: join(root, `big-${i}.jsonl`)
    }))
    const bigContent = `${JSON.stringify({ padding: 'z'.repeat(8192) })}\n`.repeat(1024)
    await Promise.all(requests.map((request) => writeFile(request.filePath, bigContent)))
    const result = await searchAiVaultTranscripts(
      { query: 'needle-in-a-haystack', requests },
      { timeBudgetMs: 5 }
    )
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('flags truncation when a large transcript is only searched head+tail', async () => {
    // Regression: a mid-transcript hit must never look like an honest zero.
    const root = await makeTranscriptRoot('middle-gap')
    const filePath = join(root, 'middle.jsonl')
    const padLine = JSON.stringify({ padding: 'x'.repeat(4096) })
    const lines: string[] = [JSON.stringify({ text: 'filler at the start' })]
    // Grow past the 2 MiB head window, then drop the only hit inside the
    // skipped middle (past the head, more than 1 MiB from the end).
    while (lines.join('\n').length < 2.2 * 1024 * 1024) {
      lines.push(padLine)
    }
    lines.push(JSON.stringify({ text: 'the buried token is zebraunicorn here' }))
    while (lines.join('\n').length < 4 * 1024 * 1024) {
      lines.push(padLine)
    }
    await writeFile(filePath, lines.join('\n'))
    const result = await searchAiVaultTranscripts({
      query: 'zebraunicorn',
      requests: [{ agent: 'claude', filePath }]
    })
    expect(result.matches).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('bounds a single record larger than the head window instead of buffering it all', async () => {
    const root = await makeTranscriptRoot('one-giant-line')
    const filePath = join(root, 'giant.jsonl')
    // One JSONL record well past head+tail budgets; the hit is at the very front.
    const giantLine = `${JSON.stringify({
      text: 'the flash attention fix is at the front'
    })}${' '.repeat(4 * 1024 * 1024)}`
    await writeFile(filePath, giantLine)
    const result = await searchAiVaultTranscripts({
      query: 'flash attention',
      requests: [{ agent: 'claude', filePath }]
    })
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0].snippet).toContain('flash attention fix')
    expect(result.truncated).toBe(true)
  })
})
