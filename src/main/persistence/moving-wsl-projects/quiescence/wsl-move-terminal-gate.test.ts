import { describe, expect, it } from 'vitest'
import {
  MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS,
  MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES
} from '../../../../shared/orcad-migration/orcad-migration-scrollback'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../../shared/terminal/replay/terminal-scrollback-limits'
import { assessWslMoveTerminals, type WslMovePaneFacts } from './wsl-move-terminal-gate'

const pane = (paneKey: string, extra: Partial<WslMovePaneFacts> = {}): WslMovePaneFacts => ({
  paneKey,
  foreground: 'shell-idle',
  scrollbackBytes: 1024,
  ...extra
})
const gate = (panes: WslMovePaneFacts[], runs: string[] = [], dispatches: string[] = []) =>
  assessWslMoveTerminals({ panes, runningAutomationRunIds: runs, activeDispatchIds: dispatches })

describe('assessWslMoveTerminals', () => {
  it('lets idle shells and resumable settled agents through', () => {
    expect(
      gate([
        pane('t1:a'),
        pane('t1:b', { agent: { state: 'done', resumable: true, ownsForeground: false } }),
        pane('t2:a', {
          agent: { state: 'done', resumable: true, ownsForeground: true },
          foreground: 'process-running'
        })
      ])
    ).toEqual({ verdict: 'ready', paneKeys: ['t1:a', 't1:b', 't2:a'] })
  })

  it.each([
    [
      'an agent mid-turn',
      { agent: { state: 'working', resumable: true, ownsForeground: true } },
      'agent-working',
      ['wait', 'end', 'skip-project']
    ],
    [
      'an agent at a permission prompt',
      { agent: { state: 'waiting', resumable: true, ownsForeground: true } },
      'agent-working',
      ['wait', 'end', 'skip-project']
    ],
    [
      // Copilot, Pi and Freebuff report a pending ask or approval as 'blocked'.
      'an agent reported blocked on a person',
      { agent: { state: 'blocked', resumable: true, ownsForeground: true } },
      'agent-working',
      ['wait', 'end', 'skip-project']
    ],
    [
      'an agent with no session to resume',
      { agent: { state: 'done', resumable: false, ownsForeground: true } },
      'agent-not-resumable',
      ['end', 'skip-project']
    ],
    ['a dev server', { foreground: 'process-running' }, 'process-running', ['end', 'skip-project']],
    [
      'a dev server under a stale agent row',
      {
        foreground: 'process-running',
        agent: { state: 'done', resumable: true, ownsForeground: false }
      },
      'process-running',
      ['end', 'skip-project']
    ],
    [
      'a pane the daemon cannot answer for',
      { foreground: 'unverifiable' },
      'unverifiable',
      ['wait', 'skip-project']
    ],
    [
      'a pane with no byte count',
      { scrollbackBytes: Number.NaN },
      'unverifiable',
      ['wait', 'skip-project']
    ],
    [
      'a pane with a negative byte count',
      { scrollbackBytes: -1 },
      'unverifiable',
      ['wait', 'skip-project']
    ],
    [
      'a pane over the scrollback cap',
      { scrollbackBytes: TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT + 1 },
      'scrollback-too-large',
      ['clear-scrollback']
    ]
  ] as const)('blocks %s, with the actions that unblock it', (_label, facts, kind, actions) => {
    expect(gate([pane('t1:a', facts)])).toEqual({
      verdict: 'blocked',
      blockers: [{ kind, ids: ['t1:a'], actions }]
    })
  })

  it.each([
    ['a done, non-resumable row', { state: 'done', resumable: false, ownsForeground: false }],
    ['a working row', { state: 'working', resumable: true, ownsForeground: false }],
    ['a waiting row', { state: 'waiting', resumable: false, ownsForeground: false }]
  ] as const)('does not let %s left on an idle shell block it', (_label, agent) => {
    expect(gate([pane('t1:a', { agent })])).toEqual({ verdict: 'ready', paneKeys: ['t1:a'] })
  })

  it('blocks on unfinished automation runs and orchestration dispatches in scope', () => {
    expect(gate([pane('t1:a')], ['run-1'], ['dispatch-1'])).toEqual({
      verdict: 'blocked',
      blockers: [
        { kind: 'automation-running', ids: ['run-1'], actions: ['wait', 'skip-project'] },
        { kind: 'dispatch-running', ids: ['dispatch-1'], actions: ['wait', 'skip-project'] }
      ]
    })
  })

  it('blocks rather than truncates when the move would exceed the transfer caps', () => {
    const many = Array.from({ length: MAX_ORCAD_MIGRATION_SCROLLBACK_SNAPSHOTS + 1 }, (_, i) =>
      pane(`t${i}:a`)
    )
    expect(gate(many)).toMatchObject({
      verdict: 'blocked',
      blockers: [{ kind: 'scrollback-too-large' }]
    })
    const perPane = Math.ceil(MAX_ORCAD_MIGRATION_SCROLLBACK_TOTAL_BYTES / 60)
    const big = Array.from({ length: 61 }, (_, i) => pane(`b${i}:a`, { scrollbackBytes: perPane }))
    expect(gate(big)).toMatchObject({
      verdict: 'blocked',
      blockers: [{ kind: 'scrollback-too-large' }]
    })
  })
})
