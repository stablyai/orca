import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { mergeAiVaultListResults } from './session-list-results'

function listResult(issues: AiVaultScanIssue[]): AiVaultListResult {
  return { sessions: [], issues, scannedAt: '2026-08-02T00:00:00.000Z' }
}

function session(index: number): AiVaultSession {
  const id = `session-${index}`
  const timestamp = new Date(Date.UTC(2026, 7, 2, 0, 0, index)).toISOString()
  return {
    id,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: id,
    title: id,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/sessions/${id}.jsonl`,
    codexHome: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    modifiedAt: timestamp,
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: id,
    subagent: null
  }
}

const SCOPE_TRUNCATION: AiVaultScanIssue = {
  executionHostId: 'ssh:dev-box',
  agent: 'codex',
  kind: 'scope',
  path: '/home/ada',
  message: 'Only the first 64 project paths were scanned.'
}

describe('mergeAiVaultListResults', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the latest input scannedAt instead of restamping the merge', () => {
    const merged = mergeAiVaultListResults(
      [
        { ...listResult([]), scannedAt: '2026-08-02T00:00:00.000Z' },
        { ...listResult([]), scannedAt: '2026-08-02T00:00:05.000Z' }
      ],
      undefined
    )

    expect(merged.scannedAt).toBe('2026-08-02T00:00:05.000Z')
  })

  it('ignores a future or unparsable remote stamp so the merge cannot pin the renderer guard', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T00:00:10.000Z'))

    expect(
      mergeAiVaultListResults(
        [
          { ...listResult([]), scannedAt: '2026-08-02T00:00:20.000Z' },
          { ...listResult([]), scannedAt: '2026-08-02T00:00:05.000Z' }
        ],
        undefined
      ).scannedAt
    ).toBe('2026-08-02T00:00:05.000Z')

    expect(
      mergeAiVaultListResults(
        [
          { ...listResult([]), scannedAt: 'scan-A' },
          { ...listResult([]), scannedAt: '2026-08-02T00:00:04.000Z' }
        ],
        undefined
      ).scannedAt
    ).toBe('2026-08-02T00:00:04.000Z')

    expect(
      mergeAiVaultListResults([{ ...listResult([]), scannedAt: 'scan-A' }], undefined).scannedAt
    ).toBe('2026-08-02T00:00:10.000Z')
  })

  // `scannedAt` is only `z.string()` on the wire, so a leg may legally send an
  // ISO variant that sorts against the local stamp differently than it reads.
  // Both cases below invert under a lexicographic compare.
  it('orders remote stamps by instant, not by string', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T00:00:10.000Z'))

    // '...:05Z' sorts after '...:05.500Z' ('Z' > '.') but is half a second older.
    expect(
      mergeAiVaultListResults(
        [
          { ...listResult([]), scannedAt: '2026-08-02T00:00:05Z' },
          { ...listResult([]), scannedAt: '2026-08-02T00:00:05.500Z' }
        ],
        undefined
      ).scannedAt
    ).toBe('2026-08-02T00:00:05.500Z')

    // A -05:00 offset makes this five hours in the future, but it sorts below
    // the local stamp ('-' < '.'), so a string compare would accept it and pin
    // the merged stamp above every later local rescan.
    expect(
      mergeAiVaultListResults(
        [
          { ...listResult([]), scannedAt: '2026-08-02T00:00:10-05:00' },
          { ...listResult([]), scannedAt: '2026-08-02T00:00:04.000Z' }
        ],
        undefined
      ).scannedAt
    ).toBe('2026-08-02T00:00:04.000Z')
  })

  // Leg order is host-enumeration order (local, then SSH, then runtime), so it
  // must not decide the merged stamp.
  it('resolves an equal-instant tie the same way in either leg order', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T00:00:10.000Z'))
    const noMillis = { ...listResult([]), scannedAt: '2026-08-02T00:00:05Z' }
    const withMillis = { ...listResult([]), scannedAt: '2026-08-02T00:00:05.000Z' }

    expect(mergeAiVaultListResults([noMillis, withMillis], undefined).scannedAt).toBe(
      '2026-08-02T00:00:05.000Z'
    )
    expect(mergeAiVaultListResults([withMillis, noMillis], undefined).scannedAt).toBe(
      '2026-08-02T00:00:05.000Z'
    )
  })

  it('normalizes the merged stamp so a leg ISO variant cannot leak into it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T00:00:10.000Z'))

    expect(
      mergeAiVaultListResults(
        [{ ...listResult([]), scannedAt: '2026-08-01T19:00:05.000-05:00' }],
        undefined
      ).scannedAt
    ).toBe('2026-08-02T00:00:05.000Z')
  })

  // `new Date(ms).toISOString()` throws RangeError outside +/-8.64e15. It cannot
  // be reached because Date.parse applies TimeClip, so a non-NaN parse is always
  // in range — pin both sides of that boundary so widening the accept guard
  // turns a would-be crash on a hostile leg stamp into a test failure.
  it('accepts the oldest representable stamp and rejects one millisecond beyond it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T00:00:10.000Z'))

    expect(
      mergeAiVaultListResults(
        [{ ...listResult([]), scannedAt: '-271821-04-20T00:00:00.000Z' }],
        undefined
      ).scannedAt
    ).toBe('-271821-04-20T00:00:00.000Z')

    expect(
      mergeAiVaultListResults(
        [{ ...listResult([]), scannedAt: '-271821-04-19T23:59:59.999Z' }],
        undefined
      ).scannedAt
    ).toBe('2026-08-02T00:00:10.000Z')
  })

  it('does not cap an Unlimited all-host merge', () => {
    const sessions = Array.from({ length: 1001 }, (_, index) => session(index))
    const merged = mergeAiVaultListResults([{ ...listResult([]), sessions }], undefined, true)

    expect(merged.sessions).toHaveLength(1001)
  })

  it('keeps a per-host scope truncation notice when merging all-host results', () => {
    const merged = mergeAiVaultListResults(
      [listResult([]), listResult([SCOPE_TRUNCATION])],
      undefined
    )

    expect(merged.issues).toEqual([SCOPE_TRUNCATION])
  })

  it('keeps one scope notice per host rather than collapsing them', () => {
    const otherHost: AiVaultScanIssue = { ...SCOPE_TRUNCATION, executionHostId: 'ssh:build-box' }

    const merged = mergeAiVaultListResults(
      [listResult([SCOPE_TRUNCATION]), listResult([otherHost])],
      undefined
    )

    expect(merged.issues.map((issue) => issue.executionHostId)).toEqual([
      'ssh:dev-box',
      'ssh:build-box'
    ])
  })

  it('keeps a scope notice alongside a failing host so one bad host is not the whole story', () => {
    const hostDown: AiVaultScanIssue = {
      executionHostId: 'ssh:build-box',
      agent: 'codex',
      kind: 'host',
      path: 'build-box',
      message: 'Remote connection dropped.'
    }

    const merged = mergeAiVaultListResults(
      [listResult([SCOPE_TRUNCATION]), listResult([hostDown])],
      undefined
    )

    expect(merged.issues).toEqual([SCOPE_TRUNCATION, hostDown])
    // Kinded issues render as their own banner rows, never as skipped transcripts.
    expect(merged.issues.filter((issue) => !issue.kind)).toEqual([])
  })
})
