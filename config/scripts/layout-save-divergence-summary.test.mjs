import { describe, expect, it } from 'vitest'
import { divergenceKind, summarizeDivergence } from './layout-save-divergence-summary.mjs'

describe('layout save divergence summary', () => {
  it('counts reports by kind and by the spec running when each was written', () => {
    const id = 'c47bcbc2-ec0c-458b-9d54-a2252e8f747a'
    const report = {
      suites: [
        {
          file: 'a.spec.ts',
          specs: [
            {
              line: 8,
              title: 'opens',
              tests: [{ results: [{ startTime: '2026-10-19T00:00:00.000Z', duration: 1000 }] }]
            }
          ]
        }
      ]
    }
    const start = Date.parse('2026-10-19T00:00:00.000Z')
    const lines = [
      JSON.stringify({
        at: start + 500,
        paths: [`group ${id} changed: tabOrder`, 'workspace added']
      }),
      // Written after the test ended, as delayed saves are.
      JSON.stringify({ at: start + 5000, paths: [`terminal ${id} tab-bar entry removed`] }),
      JSON.stringify({ at: start + 60_000, paths: ['1 pane(s) rebound'] }),
      '{"at":',
      ''
    ]
    expect(summarizeDivergence(lines, [report])).toEqual({
      reports: 3,
      paths: 4,
      unreadable: 1,
      byKind: {
        'group <id> changed: tabOrder': 1,
        'workspace added': 1,
        'terminal <id> tab-bar entry removed': 1,
        '<n> pane(s) rebound': 1
      },
      bySpec: { 'a.spec.ts:8 opens': 2, unattributed: 1 },
      bySpecAndKind: {
        'a.spec.ts:8 opens': {
          'group <id> changed: tabOrder': 1,
          'workspace added': 1,
          'terminal <id> tab-bar entry removed': 1
        },
        unattributed: { '<n> pane(s) rebound': 1 }
      }
    })
    expect(divergenceKind('tab picker-agent-tab changed: createdAt, terminal')).toBe(
      'tab <id> changed: createdAt, terminal'
    )
    expect(divergenceKind('editor view /tmp/a b/c.ts changed: viewState')).toBe(
      'editor view <id> changed: viewState'
    )
    expect(divergenceKind('file /tmp/a b/c.ts added')).toBe('file <id> added')
  })
})
