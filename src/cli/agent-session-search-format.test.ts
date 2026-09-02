import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAgentSessionSearch } from './agent-session-search-format'
import type {
  AiVaultSearchCoverage,
  AiVaultSearchHit,
  AiVaultSearchResult
} from '../shared/ai-vault-search-types'

const NOW = Date.parse('2026-09-01T12:00:00.000Z')

const COVERAGE: AiVaultSearchCoverage = {
  sessionsIndexed: 128,
  messagesIndexed: 4096,
  providers: [],
  backfill: 'complete',
  filesPending: 0,
  lastIndexedAt: '2026-09-01T11:00:00.000Z'
}

function makeHit(overrides: Partial<AiVaultSearchHit> = {}): AiVaultSearchHit {
  return {
    agent: 'claude',
    sessionId: 'sess-1',
    filePath: '/home/user/.claude/sess-1.jsonl',
    codexHome: null,
    title: 'Fix strict mode violation',
    cwd: '/home/user/code/orca',
    branch: 'session-search',
    updatedAt: '2026-09-01T11:30:00.000Z',
    messageCount: 12,
    resumeCommand: 'claude --resume sess-1',
    score: -3.4,
    evidence: {
      role: 'assistant',
      timestamp: '2026-09-01T11:29:00.000Z',
      snippet: 'the [strict] [mode] guard fires\ntwice',
      ...overrides.evidence
    },
    ...overrides
  }
}

function makeResult(overrides: Partial<AiVaultSearchResult> = {}): AiVaultSearchResult {
  return {
    hits: [makeHit()],
    route: 'and',
    durationMs: 12.6,
    coverage: COVERAGE,
    ...overrides
  }
}

function format(result: AiVaultSearchResult, query = 'strict mode'): string {
  return formatAgentSessionSearch(result, { query, cwd: '/home/user/code/orca' })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('formatAgentSessionSearch', () => {
  it('reports no match with the query when there are no hits', () => {
    const output = format(makeResult({ hits: [] }), 'kernel panic')
    expect(output.split('\n')[0]).toBe('No sessions match "kernel panic".')
    expect(output).not.toContain('resume:')
  })

  it('renders rank, title, agent label, project · branch and age on the header line', () => {
    const [header] = format(makeResult()).split('\n')
    expect(header).toBe(
      ' 1. Fix strict mode violation    Claude · orca · session-search · 30 min ago'
    )
  })

  it('renders the evidence role glyph and a single-line snippet', () => {
    const evidence = format(makeResult()).split('\n')[1]
    expect(evidence).toBe('    agent ▸ the [strict] [mode] guard fires twice')
  })

  it('labels each evidence role distinctly', () => {
    const roleOf = (role: AiVaultSearchHit['evidence']['role']): string =>
      format(
        makeResult({ hits: [makeHit({ evidence: { role, timestamp: null, snippet: 'x' } })] })
      ).split('\n')[1]
    expect(roleOf('user')).toBe('    you  ▸ x')
    expect(roleOf('tool')).toBe('    tool  ▸ x')
    expect(roleOf('system')).toBe('    sys   ▸ x')
    expect(roleOf('unknown')).toBe('          ▸ x')
  })

  it('puts the resume command and cwd on the resume line', () => {
    const resume = format(makeResult()).split('\n')[2]
    expect(resume).toBe('    resume: claude --resume sess-1  (cwd /home/user/code/orca)')
  })

  it('omits the cwd suffix and falls back to an em dash project when cwd is null', () => {
    const output = format(
      makeResult({ hits: [makeHit({ cwd: null, branch: null, updatedAt: null })] })
    )
    const [header, , resume] = output.split('\n')
    expect(header).toBe(' 1. Fix strict mode violation    Claude · — · unknown time')
    expect(resume).toBe('    resume: claude --resume sess-1')
  })

  it('drops the evidence line when the snippet is empty', () => {
    const output = format(
      makeResult({
        hits: [makeHit({ evidence: { role: 'user', timestamp: null, snippet: '' } })]
      })
    )
    expect(output.split('\n')[1]).toMatch(/^ {4}resume: /)
  })

  it('numbers hits in order with a right-aligned rank', () => {
    const hits = Array.from({ length: 10 }, (_, index) => makeHit({ title: `Session ${index}` }))
    const lines = format(makeResult({ hits })).split('\n')
    expect(lines[0]).toMatch(/^ 1\. Session 0 {4}/)
    expect(lines[27]).toMatch(/^10\. Session 9 {4}/)
  })

  it('renders coarser ages as sessions get older', () => {
    const ageFor = (updatedAt: string): string => {
      const header = format(makeResult({ hits: [makeHit({ updatedAt })] })).split('\n')[0] ?? ''
      return header.split(' · ').at(-1) ?? ''
    }
    expect(ageFor('2026-09-01T11:59:59.000Z')).toBe('1 min ago')
    expect(ageFor('2026-09-01T02:00:00.000Z')).toBe('10 h ago')
    expect(ageFor('2026-08-28T12:00:00.000Z')).toBe('4 d ago')
    expect(ageFor('2026-08-01T12:00:00.000Z')).toBe('4 wk ago')
    expect(ageFor('2026-01-01T12:00:00.000Z')).toBe('8 mo ago')
    // A future timestamp (clock skew) must not render a negative age.
    expect(ageFor('2026-09-02T12:00:00.000Z')).toBe('just now')
  })

  it('shows "Searched for:" only when the query was repaired', () => {
    expect(format(makeResult())).not.toContain('Searched for:')
    expect(format(makeResult({ repairedTerms: ['strict', 'mode'] }))).toContain(
      'Searched for: strict mode'
    )
  })

  it('closes with the indexed-session count and duration', () => {
    const footer = format(makeResult()).split('\n').at(-1)
    expect(footer).toBe('128 sessions indexed · 13 ms')
  })

  it('says older sessions are still indexing while backfill runs', () => {
    const footer = format(
      makeResult({ coverage: { ...COVERAGE, backfill: 'running', filesPending: 3 } })
    )
      .split('\n')
      .at(-1)
    expect(footer).toBe('128 sessions indexed, still indexing older sessions · 13 ms')
  })

  it('names pending changed files once backfill is done', () => {
    const footer = format(makeResult({ coverage: { ...COVERAGE, filesPending: 4 } }))
      .split('\n')
      .at(-1)
    expect(footer).toBe('128 sessions indexed, 4 changed files pending · 13 ms')
  })
})
