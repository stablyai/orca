import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  extractFullFirstUserPromptText,
  extractPreviewContentText,
  normalizeAgentSessionsDir,
  normalizeFullFirstUserPromptText,
  normalizePrimeAgentSessionsDir,
  primeAgentSessionsDirFromEnv,
  normalizePreviewText,
  normalizeTitleText
} from './session-scanner-values'

describe('AI Vault session scanner text values', () => {
  it('normalizes compact title text without surfacing hidden context blocks', () => {
    expect(
      normalizeTitleText(
        '  <system-reminder>ignore me</system-reminder>\n' +
          '<goal_context>keep going</goal_context>\tFix   the picker  '
      )
    ).toBe('Fix the picker')
    expect(normalizeTitleText('# AGENTS.md instructions for /repo/app <INSTRUCTIONS>')).toBeNull()
    expect(normalizeTitleText('<INSTRUCTIONS>Use this repo guidance')).toBeNull()
  })

  it("drops a reply's visual lines from its preview, but not a user's", () => {
    const line = '::orca-visual{file="latency.html" title="p95"}'
    expect(normalizePreviewText(`p95 is highest.\n\n${line}\n\nDone.`, 'assistant')).toBe(
      'p95 is highest. Done.'
    )
    expect(normalizePreviewText(line, 'assistant')).toBeNull()
    expect(normalizePreviewText(line, 'user')).toBe(line)
    expect(
      extractPreviewContentText(
        [{ type: 'text', text: `Here it is.\n\n${line}\n\nDone.` }],
        'assistant'
      )
    ).toBe('Here it is. Done.')
    expect(extractPreviewContentText(`Here it is.\n${line}`, 'assistant')).toBe('Here it is.')
    expect(extractPreviewContentText([{ type: 'text', text: line }], 'user')).toBe(line)
  })

  it('folds large preview text directly without full-string replacement', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const hiddenContext = `<codex_internal_context source="goal">${'SECRET\n'.repeat(10_000)}</codex_internal_context>`
    const result = normalizePreviewText(`${hiddenContext}\nVisible preview ${'copy '.repeat(120)}`)
    const replaceCalls = replaceSpy.mock.calls.length

    expect(replaceCalls).toBe(0)
    expect(result?.startsWith('Visible preview copy copy')).toBe(true)
    expect(result).not.toContain('SECRET')
    expect(result?.endsWith('...')).toBe(true)
  })

  it('stops reading preview array items after the bounded display text is settled', () => {
    const unreadItem = {}
    Object.defineProperty(unreadItem, 'text', {
      get() {
        throw new Error('later preview items should not be read')
      }
    })

    const result = extractPreviewContentText([
      { type: 'text', text: 'Visible preview '.repeat(30) },
      unreadItem
    ])
    const normalizedPreview = Array.from({ length: 30 }, () => 'Visible preview').join(' ')

    expect(result).toBe(`${normalizedPreview.slice(0, 217)}...`)
  })

  it('keeps truncation from splitting surrogate pairs', () => {
    const result = normalizePreviewText(`${'a'.repeat(216)}😀tail`)

    expect(result).toBe(`${'a'.repeat(216)}...`)
  })

  it('preserves full first-prompt text including newlines for copy', () => {
    const body = `First prompt line one\n\nline two ${'word '.repeat(100)}`
    expect(normalizeFullFirstUserPromptText(body)).toBe(body.trim())
    expect(extractFullFirstUserPromptText([{ type: 'text', text: body }])).toBe(body.trim())
  })

  it('reads Codex input_text blocks and ignores tool blocks', () => {
    const body = `Review the PR\n\n${'detail '.repeat(50).trimEnd()}`
    expect(extractFullFirstUserPromptText([{ type: 'input_text', text: body }])).toBe(body)
    expect(
      extractFullFirstUserPromptText([
        { type: 'tool_result', content: 'src/main/window.ts was updated' },
        { type: 'text', text: 'Please continue the editor refactor' }
      ])
    ).toBe('Please continue the editor refactor')
  })

  it('expands Pi and OMP agent homes to their session directories', () => {
    expect(normalizeAgentSessionsDir('/agents/.pi', '.pi')).toBe('/agents/.pi/agent/sessions')
    expect(normalizeAgentSessionsDir('/agents/.pi/agent', '.pi')).toBe('/agents/.pi/agent/sessions')
    expect(normalizeAgentSessionsDir('/agents/.pi/agent/sessions', '.pi')).toBe(
      '/agents/.pi/agent/sessions'
    )

    expect(normalizeAgentSessionsDir('/agents/.omp', '.omp')).toBe('/agents/.omp/agent/sessions')
    expect(normalizeAgentSessionsDir('/agents/.omp/agent', '.omp')).toBe(
      '/agents/.omp/agent/sessions'
    )
    expect(normalizeAgentSessionsDir('/agents/.omp/agent/sessions', '.omp')).toBe(
      '/agents/.omp/agent/sessions'
    )
  })

  it('maps any Prime Agent agent dir to its sessions child', () => {
    expect(normalizePrimeAgentSessionsDir('/tmp/prime-agent')).toBe('/tmp/prime-agent/sessions')
    expect(normalizePrimeAgentSessionsDir('/tmp/prime-agent///')).toBe('/tmp/prime-agent/sessions')
    expect(normalizePrimeAgentSessionsDir('/agents/.prime')).toBe('/agents/.prime/sessions')
    expect(normalizePrimeAgentSessionsDir('/agents/.prime/agent')).toBe(
      '/agents/.prime/agent/sessions'
    )
  })

  it('still appends sessions when the agent dir is itself named sessions', () => {
    expect(normalizePrimeAgentSessionsDir('/data/sessions')).toBe('/data/sessions/sessions')
  })

  it('expands a leading tilde in the agent dir', () => {
    expect(normalizePrimeAgentSessionsDir('~/work/prime')).toBe(
      join(homedir(), 'work', 'prime', 'sessions')
    )
  })

  // Drive-relative paths are invalid on POSIX too; native Windows semantics need a Windows runner.
  it('falls back to the default root for every non-absolute agent dir', () => {
    const fallback = join(homedir(), '.prime', 'agent', 'sessions')
    for (const value of [
      '/',
      '//',
      '   ',
      '',
      '.',
      '..',
      'sessions',
      'rel/path',
      'C:\\',
      'C:/',
      'C:foo'
    ]) {
      expect(normalizePrimeAgentSessionsDir(value)).toBe(fallback)
    }
  })

  describe('primeAgentSessionsDirFromEnv', () => {
    const defaultDir = join(homedir(), '.prime', 'agent', 'sessions')

    it('defaults to the home agent dir when nothing is configured', () => {
      expect(primeAgentSessionsDirFromEnv({})).toBe(defaultDir)
    })

    it('appends sessions to a configured agent dir', () => {
      expect(primeAgentSessionsDirFromEnv({ PRIME_AGENT_CODING_AGENT_DIR: '/opt/prime' })).toBe(
        '/opt/prime/sessions'
      )
    })

    it('prefers the sessions-root overrides verbatim over the agent dir', () => {
      expect(
        primeAgentSessionsDirFromEnv({
          PRIME_AGENT_CODING_AGENT_DIR: '/opt/prime',
          PRIME_AGENT_SESSION_DIR: '/mnt/transcripts'
        })
      ).toBe('/mnt/transcripts')
      expect(
        primeAgentSessionsDirFromEnv({
          PRIME_AGENT_CODING_AGENT_DIR: '/opt/prime',
          PRIME_AGENT_CODING_AGENT_SESSION_DIR: '/mnt/legacy'
        })
      ).toBe('/mnt/legacy')
      expect(
        primeAgentSessionsDirFromEnv({
          PRIME_AGENT_SESSION_DIR: '/mnt/wins',
          PRIME_AGENT_CODING_AGENT_SESSION_DIR: '/mnt/legacy'
        })
      ).toBe('/mnt/wins')
    })

    it('expands a tilde and rejects a non-absolute sessions-root override', () => {
      expect(primeAgentSessionsDirFromEnv({ PRIME_AGENT_SESSION_DIR: '~/t' })).toBe(
        join(homedir(), 't')
      )
      for (const value of ['/', '.', '..', 'rel/path', '   ', 'C:foo']) {
        expect(primeAgentSessionsDirFromEnv({ PRIME_AGENT_SESSION_DIR: value })).toBe(defaultDir)
      }
    })
  })
})
