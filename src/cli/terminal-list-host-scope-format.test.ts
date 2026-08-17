import { describe, expect, it } from 'vitest'
import { formatTerminalList } from './format'
import type { RuntimeTerminalListResult, RuntimeTerminalSummary } from '../shared/runtime-types'

function terminal(overrides: Partial<RuntimeTerminalSummary> = {}): RuntimeTerminalSummary {
  return {
    handle: 'term_1',
    ptyId: 'pty-1',
    worktreeId: 'repo::/repo',
    worktreePath: '/repo',
    branch: 'main',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    title: 'worker',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

function listResult(overrides: Partial<RuntimeTerminalListResult> = {}): RuntimeTerminalListResult {
  return { terminals: [terminal()], totalCount: 1, truncated: false, ...overrides }
}

describe('formatTerminalList host identity', () => {
  it('prints the execution host each terminal runs on', () => {
    const output = formatTerminalList(
      listResult({ terminals: [terminal({ executionHostId: 'ssh:box-1' })] })
    )

    expect(output).toContain('host=ssh:box-1')
  })

  it('prints unverifiable, not local, for a row whose host the runtime could not name', () => {
    const output = formatTerminalList(listResult({ terminals: [terminal()] }))

    expect(output).toContain('host=unverifiable')
    expect(output).not.toContain('host=local')
  })
})

describe('formatTerminalList scope declaration', () => {
  it('states the covered and omitted hosts', () => {
    const output = formatTerminalList(
      listResult({
        hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:box-1'] }
      })
    )

    expect(output).toContain('scope: local')
    expect(output).toContain('not covered: ssh:box-1')
  })

  it('keeps an empty listing self-describing instead of reading as absolute', () => {
    const output = formatTerminalList(
      listResult({
        terminals: [],
        totalCount: 0,
        hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:box-1'] }
      })
    )

    expect(output).toContain('No terminals listed')
    expect(output).toContain('scope: local')
    expect(output).toContain('not covered: ssh:box-1')
  })

  it('says the scope is unverifiable when the host predates the field', () => {
    const output = formatTerminalList(listResult())

    expect(output).toContain('scope: unverifiable')
    expect(output).not.toContain('scope: local')
  })
})
