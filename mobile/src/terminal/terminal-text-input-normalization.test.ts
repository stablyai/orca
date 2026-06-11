import { describe, expect, it } from 'vitest'

import { normalizeTerminalTextInput } from './terminal-text-input-normalization'

describe('normalizeTerminalTextInput', () => {
  it('converts iOS smart dash replacements back to terminal hyphens', () => {
    expect(normalizeTerminalTextInput('git checkout – file')).toBe('git checkout -- file')
    expect(normalizeTerminalTextInput('git checkout — file')).toBe('git checkout -- file')
  })

  it('keeps ASCII hyphens unchanged', () => {
    expect(normalizeTerminalTextInput('git checkout -- file')).toBe('git checkout -- file')
  })

  it('preserves longer trailing hyphen runs when iOS re-collapses the controlled value', () => {
    expect(normalizeTerminalTextInput('—', '--')).toBe('---')
    expect(normalizeTerminalTextInput('—', '---')).toBe('----')
    expect(normalizeTerminalTextInput('git checkout —', 'git checkout --')).toBe('git checkout ---')
  })
})
