import { describe, expect, it } from 'vitest'
import {
  formatQuickCommandList,
  formatQuickCommandRemoval,
  formatQuickCommandShow
} from './quick-command-format'
import type { TerminalQuickCommand } from '../shared/terminal-quick-command-types'

const shell: TerminalQuickCommand = {
  id: 'qc-1',
  label: 'Run tests',
  scope: { type: 'global' },
  action: 'terminal-command',
  command: 'pnpm test',
  appendEnter: true
}

const agent: TerminalQuickCommand = {
  id: 'qc-2',
  label: 'Review',
  scope: { type: 'repo', repoId: 'repo-1' },
  action: 'agent-prompt',
  agent: 'claude',
  prompt: 'review the diff'
}

describe('formatQuickCommandList', () => {
  it('reports an empty list', () => {
    expect(formatQuickCommandList({ quickCommands: [], repoId: null })).toBe('No quick commands')
  })

  it('renders scope and action for each row', () => {
    const output = formatQuickCommandList({ quickCommands: [shell, agent], repoId: 'repo-1' })
    expect(output).toContain('qc-1  Run tests')
    expect(output).toContain('scope: global  action: terminal-command')
    expect(output).toContain('scope: repo:repo-1  action: agent-prompt(claude)')
    expect(output).toContain('body: pnpm test')
  })

  it('marks a command that is typed without being submitted', () => {
    const output = formatQuickCommandList({
      quickCommands: [{ ...shell, appendEnter: false }],
      repoId: null
    })
    expect(output).toContain('action: terminal-command(no-enter)')
  })

  it('collapses a multi-line body onto one line', () => {
    const output = formatQuickCommandList({
      quickCommands: [{ ...shell, command: 'pnpm lint\npnpm test' }],
      repoId: null
    })
    expect(output).toContain('body: pnpm lint ⏎ pnpm test')
    expect(output.split('\n').filter((line) => line.startsWith('  body:'))).toHaveLength(1)
  })

  it('falls back to a placeholder for an unlabelled command', () => {
    expect(
      formatQuickCommandList({ quickCommands: [{ ...shell, label: '' }], repoId: null })
    ).toContain('qc-1  (untitled)')
  })
})

describe('formatQuickCommandShow', () => {
  it('renders a single agent-prompt row', () => {
    const output = formatQuickCommandShow({ quickCommand: agent })
    expect(output).toContain('qc-2  Review')
    expect(output).toContain('body: review the diff')
  })
})

describe('formatQuickCommandRemoval', () => {
  it('names the removed command', () => {
    expect(formatQuickCommandRemoval({ removed: shell, quickCommands: [] })).toBe(
      'Removed qc-1 (Run tests)'
    )
  })

  it('falls back to a placeholder for an unlabelled command', () => {
    expect(formatQuickCommandRemoval({ removed: { ...shell, label: '' }, quickCommands: [] })).toBe(
      'Removed qc-1 (untitled)'
    )
  })
})
