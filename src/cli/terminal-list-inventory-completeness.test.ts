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

describe('formatTerminalList inventory completeness', () => {
  it('reports an incomplete inventory when a host was omitted, even with truncated false', () => {
    const output = formatTerminalList(
      listResult({
        truncated: false,
        hostScope: {
          hostIds: ['local'],
          omittedHostIds: ['ssh:box-1'],
          complete: false,
          observedAt: 0
        }
      })
    )

    expect(output).toContain('inventory: incomplete')
  })

  it('reports a complete inventory with the observation time that bounds it', () => {
    const output = formatTerminalList(
      listResult({
        hostScope: { hostIds: ['local'], omittedHostIds: [], complete: true, observedAt: 0 }
      })
    )

    expect(output).toContain('inventory: complete')
    expect(output).toContain('1970-01-01T00:00:00.000Z')
  })

  it('reads an absent verdict as unverifiable rather than complete', () => {
    const output = formatTerminalList(
      listResult({ hostScope: { hostIds: ['local'], omittedHostIds: [] } })
    )

    expect(output).toContain('inventory: unverifiable')
    expect(output).not.toContain('inventory: complete')
  })

  it('keeps an empty listing from reading as a complete absence', () => {
    const output = formatTerminalList(listResult({ terminals: [], totalCount: 0 }))

    expect(output).toContain('inventory: unverifiable')
  })

  it('surfaces the exact reservation binding on a terminal row', () => {
    const output = formatTerminalList(
      listResult({
        terminals: [
          terminal({
            reservation: {
              key: 'key-1',
              reservationId: 'res-1',
              sessionId: 'session-1',
              resourceKind: 'terminal',
              ownershipGeneration: 4,
              issuer: 'openloop',
              boundAt: 7
            }
          })
        ]
      })
    )

    expect(output).toContain('"reservationId":"res-1"')
    expect(output).toContain('"ownershipGeneration":4')
  })
})
