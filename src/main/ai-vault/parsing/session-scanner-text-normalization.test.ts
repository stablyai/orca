import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractFullFirstUserPromptText } from '../prompts/session-scanner-first-user-prompt'
import {
  extractPreviewContentText,
  normalizePreviewText,
  normalizeTitleText
} from './session-scanner-text-normalization'
import { primeAgentSessionsDirFromEnv } from '../discovery/agent-session-directories'

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

  it('keeps truncation from splitting surrogate pairs', () => {
    const result = normalizePreviewText(`${'a'.repeat(216)}😀tail`)

    expect(result).toBe(`${'a'.repeat(216)}...`)
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

  // Drive-relative paths are invalid on POSIX too; native Windows semantics need a Windows runner.

  describe('primeAgentSessionsDirFromEnv', () => {
    const defaultDir = join(homedir(), '.prime', 'agent', 'sessions')

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
