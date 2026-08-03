import { describe, expect, it, vi } from 'vitest'
import {
  extractFullFirstUserPromptText,
  extractPreviewContentText,
  normalizeAgentSessionsDir,
  normalizeFullFirstUserPromptText,
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
})
