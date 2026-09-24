import { describe, expect, it } from 'vitest'
import {
  formatSessionSearchResponse,
  formatSessionSearchStatus,
  terminalSafe
} from './agent-session-search-format'
import type {
  AiVaultSearchHit,
  AiVaultSearchResponse,
  AiVaultSearchStatus
} from '../shared/ai-vault-search-types'

const localHit: AiVaultSearchHit = {
  agent: 'claude',
  executionHostId: 'ssh:build-01',
  sessionId: 'session-1',
  title: 'Terminal resize race on Windows',
  cwd: 'C:\\src\\orca',
  branch: 'main',
  updatedAt: '2026-09-12T18:04:11.000Z',
  messageCount: 214,
  score: 12.5,
  source: { presence: 'present', filePath: '/transcripts/session-1.jsonl' },
  evidence: {
    snippet: 'the [[resize]] handler drops the first event',
    role: 'assistant',
    timestamp: '2026-09-12T18:04:11.000Z'
  },
  resumeCommand: 'claude --resume session-1'
}

const evidencelessHit: AiVaultSearchHit = {
  agent: 'codex',
  sessionId: 'session-2',
  title: 'Index sweep budget',
  cwd: null,
  branch: null,
  updatedAt: null,
  messageCount: 4,
  score: 3,
  source: { presence: 'unverifiable' },
  evidence: null
}

function results(overrides: Partial<Extract<AiVaultSearchResponse, { kind: 'results' }>> = {}) {
  return {
    kind: 'results' as const,
    hits: [localHit],
    page: { cursor: null, hasMore: false },
    generation: 42,
    truncated: { candidates: false, snippets: 0, query: false, freshness: false },
    durationMs: 18,
    ...overrides
  }
}

describe('formatSessionSearchResponse: results', () => {
  it('prints one line per hit with the snippet indented under it', () => {
    expect(formatSessionSearchResponse(results())).toBe(
      [
        'Claude  2026-09-12T18:04:11.000Z  Terminal resize race on Windows  host=ssh:build-01',
        '    assistant: the [[resize]] handler drops the first event',
        '    resume: claude --resume session-1',
        '',
        '1 result on this page, 18 ms.'
      ].join('\n')
    )
  })

  it('leaves the [[ ]] match marks exactly as the engine wrote them', () => {
    expect(formatSessionSearchResponse(results())).toContain('[[resize]]')
  })

  it('omits the host and the resume line a paired host withheld', () => {
    const { executionHostId: _host, resumeCommand: _resume, ...withheld } = localHit
    expect(formatSessionSearchResponse(results({ hits: [withheld] }))).toBe(
      [
        'Claude  2026-09-12T18:04:11.000Z  Terminal resize race on Windows',
        '    assistant: the [[resize]] handler drops the first event',
        '',
        '1 result on this page, 18 ms.'
      ].join('\n')
    )
  })

  it('says so when a hit matched with no text evidence', () => {
    expect(formatSessionSearchResponse(results({ hits: [evidencelessHit] }))).toContain(
      'Codex  unknown time  Index sweep budget\n    no text evidence for this match'
    )
  })

  it('reports zero hits as an answer, not a failure', () => {
    expect(formatSessionSearchResponse(results({ hits: [] }))).toBe(
      ['No sessions match this query.', '', '0 results on this page, 18 ms.'].join('\n')
    )
  })

  it('prints the cursor a caller passes back for the next page', () => {
    expect(
      formatSessionSearchResponse(results({ page: { cursor: 'eyJ2IjoxfQ', hasMore: true } }))
    ).toContain('more pages: re-run with --cursor eyJ2IjoxfQ')
  })

  it('admits more pages exist when the host issued no cursor', () => {
    expect(
      formatSessionSearchResponse(results({ page: { cursor: null, hasMore: true } }))
    ).toContain('more pages exist, but this host issued no cursor for them')
  })

  it('renders every truncation flag in words', () => {
    const text = formatSessionSearchResponse(
      results({ truncated: { candidates: true, snippets: 3, query: true, freshness: true } })
    )
    expect(text).toContain(
      'ranking saw only the first batch of candidate sessions, so a better match may be missing'
    )
    expect(text).toContain('query was cut')
    expect(text).toContain(
      'freshness wait timed out; these results come from the index as it stood'
    )
    expect(text).toContain('3 snippets were shortened')
  })

  it('prints nothing about truncation when nothing was truncated', () => {
    expect(formatSessionSearchResponse(results())).not.toContain('truncat')
  })

  it('prints the planner route only when the host sent debug', () => {
    expect(formatSessionSearchResponse(results())).not.toContain('debug:')
    expect(
      formatSessionSearchResponse(
        results({
          debug: {
            route: 'typo+phrase',
            repairedTerms: ['resize'],
            plannerReport: { route: 'typo+phrase', repairedTerms: ['resize'], scope: 'all' }
          }
        })
      )
    ).toContain(
      ['debug:', '  route: typo+phrase', '  repairedTerms: resize', '  plannerScope: all'].join(
        '\n'
      )
    )
  })
})

describe('formatSessionSearchResponse: non-result answers', () => {
  it('reports a disabled index', () => {
    expect(formatSessionSearchResponse({ kind: 'unavailable', reason: 'disabled' })).toBe(
      'Session search is off on this host.'
    )
  })

  it('names an index that has not started', () => {
    expect(formatSessionSearchResponse({ kind: 'unavailable', reason: 'not-ready' })).toContain(
      'not ready on this host yet'
    )
  })

  it('tells an old host apart as a host with no service', () => {
    expect(formatSessionSearchResponse({ kind: 'unavailable', reason: 'no-service' })).toBe(
      [
        'This host runs no session search service.',
        'An Orca host older than session search answers the same way; update it and try again.'
      ].join('\n')
    )
  })

  it('says the index moved and to drop the cursor', () => {
    expect(formatSessionSearchResponse({ kind: 'stale-cursor', generation: 7 })).toBe(
      [
        'The index moved on since that page, so the cursor no longer names a place in it.',
        'Re-run the same search without --cursor to start again from page 1.'
      ].join('\n')
    )
  })
})

describe('terminal safety', () => {
  it('strips escape sequences a transcript could carry into the reader terminal', () => {
    expect(terminalSafe('before\u001b]52;c;cGF5bG9hZA==\u0007after')).toBe('beforeafter')
    expect(terminalSafe('red \u001b[31mtext\u001b[0m')).toBe('red text')
  })

  it.each([
    ['updatedAt', { updatedAt: '2026-09-12\u001b[31mT18:04:11.000Z' }, '\u001b'],
    ['executionHostId', { executionHostId: 'ssh:\u001b]0;pwned\u0007build-01' }, '\u001b'],
    ['title', { title: 'resize\u001b[2Jrace' }, '\u001b'],
    ['evidence snippet', { evidence: { ...localHit.evidence!, snippet: 'a\u001b[1mb' } }, '\u001b'],
    ['resumeCommand', { resumeCommand: 'claude \u001b[3Jresume' }, '\u001b']
  ])('strips an escape sequence a host put in %s', (_field, override, escape) => {
    const text = formatSessionSearchResponse(results({ hits: [{ ...localHit, ...override }] }))

    expect(text).not.toContain(escape)
  })

  it('strips an escape sequence a host put in the next-page cursor', () => {
    const text = formatSessionSearchResponse(
      results({ page: { cursor: 'eyJ2\u001b[31mIjoxfQ', hasMore: true } })
    )

    expect(text).toContain('more pages: re-run with --cursor eyJ2IjoxfQ')
    expect(text).not.toContain('\u001b')
  })

  it('strips an escape sequence a host put in a repaired term', () => {
    const text = formatSessionSearchResponse(
      results({
        debug: {
          route: 'typo+phrase',
          repairedTerms: ['resize\u001b[31m', '\u001b]0;t\u0007race'],
          plannerReport: { route: 'typo+phrase', scope: 'all' }
        }
      })
    )

    expect(text).toContain('  repairedTerms: resize race')
    expect(text).not.toContain('\u001b')
  })

  it.each([
    ['root', { root: '/Users/me/\u001b[31m.codex', reason: 'EACCES' }],
    ['reason', { root: '/r', reason: 'EACCES\u001b]0;x\u0007' }]
  ])('strips an escape sequence a host put in a degraded %s', (_field, degradedRoot) => {
    const text = formatSessionSearchStatus({
      enabled: true,
      phase: 'degraded',
      filesIndexed: 1,
      filesDue: 0,
      filesFailed: 1,
      degradedRoots: [degradedRoot],
      lastReconcileAt: null,
      lastSweepCompletedAt: null,
      generation: 1
    })

    expect(text).not.toContain('\u001b')
  })

  it('keeps a snippet on the one indented line it was given', () => {
    const text = formatSessionSearchResponse(
      results({
        hits: [
          {
            ...localHit,
            title: 'wrapped\ntitle',
            evidence: { ...localHit.evidence!, snippet: 'first\nsecond\u0007' }
          }
        ]
      })
    )
    expect(text).toContain('Claude  2026-09-12T18:04:11.000Z  wrapped title  host=ssh:build-01')
    expect(text).toContain('    assistant: first second')
  })
})

describe('formatSessionSearchStatus', () => {
  const status: AiVaultSearchStatus = {
    enabled: true,
    phase: 'indexing',
    filesIndexed: 5535,
    filesDue: 12,
    filesFailed: 1,
    degradedRoots: [{ root: '/Users/me/.codex', reason: 'EACCES' }],
    lastReconcileAt: 1789000000000,
    lastSweepCompletedAt: null,
    generation: 42
  }

  it('reports the indexer observations one per line', () => {
    expect(formatSessionSearchStatus(status)).toBe(
      [
        'enabled: true',
        'phase: indexing',
        'filesIndexed: 5535',
        'filesDue: 12',
        'filesFailed: 1',
        'lastReconcileAt: 2026-09-10T00:26:40.000Z',
        'lastSweepCompletedAt: never',
        'generation: 42',
        'degradedRoots: 1',
        '  /Users/me/.codex: EACCES'
      ].join('\n')
    )
  })

  it('keeps the count when a paired host withheld the root', () => {
    expect(
      formatSessionSearchStatus({
        ...status,
        degradedRoots: [{ reason: 'Source root could not be verified.' }]
      })
    ).toContain('degradedRoots: 1\n  (withheld): Source root could not be verified.')
  })
})
