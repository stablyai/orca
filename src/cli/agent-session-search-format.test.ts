import { describe, expect, it } from 'vitest'
import {
  formatSessionSearchResponse,
  formatSessionSearchStatus
} from './agent-session-search-format'
import type { AiVaultSearchHit, AiVaultSearchResponse } from '../shared/ai-vault-search-types'

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

describe('terminal safety', () => {
  it.each([
    [
      'updatedAt',
      { updatedAt: '2026-09-12\u001b[31mT18:04:11.000Z' },
      'Claude  2026-09-12T18:04:11.000Z'
    ],
    [
      'executionHostId',
      { executionHostId: 'ssh:\u001b]0;pwned\u0007build-01' },
      'host=ssh:build-01'
    ],
    ['title', { title: 'resize\u001b[2Jrace' }, '  resizerace  host='],
    [
      'evidence snippet',
      { evidence: { ...localHit.evidence!, snippet: 'a\u001b[1mb' } },
      '    assistant: ab'
    ],
    ['resumeCommand', { resumeCommand: 'claude \u001b[3Jresume' }, '    resume: claude resume']
  ])('strips an escape sequence a host put in %s', (_field, override, expected) => {
    const text = formatSessionSearchResponse(results({ hits: [{ ...localHit, ...override }] }))

    expect(text).toContain(expected)
    expect(text).not.toContain('\u001b')
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
    [
      'root',
      { root: '/Users/me/\u001b[31m.codex', reason: 'EACCES' },
      '  /Users/me/.codex: EACCES'
    ],
    ['reason', { root: '/r', reason: 'EACCES\u001b]0;x\u0007' }, '  /r: EACCES']
  ])('strips an escape sequence a host put in a degraded %s', (_field, degradedRoot, expected) => {
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

    expect(text).toContain(expected)
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
