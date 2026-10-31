import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { truncateAiVaultListResult } from '../../shared/ai-vault-session-depth'
import { parseAiVaultListResult } from './session-list-result-validation'
import { mergeAiVaultListResults, restampAiVaultListResult } from './session-list-results'

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

describe('restampAiVaultListResult', () => {
  const catalogs = [
    { name: 'empty', result: listResult([]) },
    {
      name: 'populated',
      result: { ...listResult([SCOPE_TRUNCATION]), sessions: [session(1)] }
    },
    {
      name: 'unchanged',
      result: { ...listResult([]), fingerprint: 'a'.repeat(64), unchanged: true as const }
    }
  ]

  it.each(catalogs)('preserves confirmed $name catalog coverage through parsing', ({ result }) => {
    const stamped = restampAiVaultListResult(
      { ...result, includesStructuredSessions: true },
      'runtime:server'
    )
    const parsed = parseAiVaultListResult(stamped)

    expect(parsed).toEqual(stamped)
    expect(parsed.includesStructuredSessions).toBe(true)
    expect(parsed.sessions.every((row) => row.executionHostId === 'runtime:server')).toBe(true)
    expect(parsed.issues.every((issue) => issue.executionHostId === 'runtime:server')).toBe(true)
  })

  it.each(catalogs)('does not claim coverage for a legacy $name catalog', ({ result }) => {
    const parsed = parseAiVaultListResult(restampAiVaultListResult(result, 'runtime:server'))

    expect(parsed).not.toHaveProperty('includesStructuredSessions')
  })

  it.each([
    { name: 'full', metadata: { fingerprint: 'a'.repeat(64) } },
    { name: 'unchanged', metadata: { fingerprint: 'a'.repeat(64), unchanged: true as const } },
    { name: 'cancelled', metadata: { cancelled: true as const } }
  ])('omits the local scan id while preserving $name reply metadata', ({ metadata }) => {
    const expected = { ...listResult([]), ...metadata, includesStructuredSessions: true as const }
    const original = { ...expected, scanId: 'local-scan' }

    expect(restampAiVaultListResult(original, 'runtime:server')).toEqual(expected)
    expect(original.scanId).toBe('local-scan')
  })

  it.each([false, null, 'true', 1, {}])('rejects an invalid coverage marker: %j', (marker) => {
    expect(() =>
      parseAiVaultListResult({
        ...restampAiVaultListResult(listResult([]), 'runtime:server'),
        includesStructuredSessions: marker
      })
    ).toThrow()
  })
})

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

  it('orders remote stamps by instant, not by string', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-02T00:00:10.000Z'))

    // Z sorts after the fractional dot even though this instant is earlier.
    expect(
      mergeAiVaultListResults(
        [
          { ...listResult([]), scannedAt: '2026-08-02T00:00:05Z' },
          { ...listResult([]), scannedAt: '2026-08-02T00:00:05.500Z' }
        ],
        undefined
      ).scannedAt
    ).toBe('2026-08-02T00:00:05.500Z')

    // This future offset sorts before the local stamp; string ordering would accept it.
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
    expect(merged.issues.filter((issue) => !issue.kind)).toEqual([])
  })
})

it('retains recovered scope rows through All-computers aggregation and smaller cached depths', () => {
  const local = {
    ...listResult([SCOPE_TRUNCATION]),
    sessions: [{ ...session(4), cwd: '/other' }, { ...session(3), cwd: '/other' }, session(1)]
  }
  const merged = mergeAiVaultListResults([local, listResult([])], 2, false, ['/repo'])
  expect(merged.sessions.map((row) => row.sessionId)).toEqual([
    'session-4',
    'session-3',
    'session-1'
  ])
  expect(
    truncateAiVaultListResult(merged, 1, ['/repo']).sessions.map((row) => row.sessionId)
  ).toEqual(['session-4', 'session-1'])
  expect(merged.issues).toEqual([SCOPE_TRUNCATION])
  expect(merged.scannedAt).toBe(local.scannedAt)
})
