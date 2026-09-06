import { describe, expect, it } from 'vitest'
import { formatTerminalCreate, formatTerminalList, formatTerminalShow } from './format'
import type { RuntimeTerminalSummary } from '../shared/runtime-types'

function terminal(tabTitle?: string | null): RuntimeTerminalSummary {
  return {
    handle: 'term_worker',
    ptyId: 'pty-1',
    worktreeId: 'repo::/repo',
    worktreePath: '/repo',
    branch: 'main',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    title: '⠸ orchestration-v3',
    tabTitle,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: ''
  }
}

describe('terminal tab title formatting', () => {
  it('uses the user title as the list label', () => {
    const output = formatTerminalList({
      terminals: [terminal('Codex: skills review')],
      totalCount: 1,
      truncated: false
    })
    expect(output).toContain('term_worker  Codex: skills review  connected')
  })

  it.each([undefined, null])('falls back to the live title for tabTitle=%s', (tabTitle) => {
    const output = formatTerminalList({
      terminals: [terminal(tabTitle)],
      totalCount: 1,
      truncated: false
    })
    expect(output).toContain('term_worker  ⠸ orchestration-v3  connected')
  })

  it('uses the user title in the create confirmation', () => {
    const output = formatTerminalCreate({ terminal: terminal('Codex: skills review') })
    expect(output).toContain('Created terminal term_worker (title: "Codex: skills review")')
  })

  it('shows user and live titles separately', () => {
    const output = formatTerminalShow({
      terminal: { ...terminal('Codex: skills review'), paneRuntimeId: 1, rendererGraphEpoch: 1 }
    })
    expect(output).toContain('title: ⠸ orchestration-v3')
    expect(output).toContain('tabTitle: Codex: skills review')
  })
})
