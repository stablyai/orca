import { describe, expect, it } from 'vitest'
import { violations } from './check-agent-status-map-ratchet.mjs'

describe('accepted agent status Map contract', () => {
  it('rejects Record operations through aliases and destructuring', () => {
    const failures = violations(
      'reader.ts',
      `
      const { agentStatusByPaneKey: owner } = state
      const rows = owner
      Object.keys(rows)
      Object.values(rows)
      Object.entries(rows)
      JSON.stringify(rows)
      const copy = { ...rows }
      rows[key]
      key in rows
      for (const key in rows) consume(key)
    `
    )
    expect(failures.length).toBe(8)
  })
  it('allows keyed reads, explicit full-output iteration and independent Record bindings', () => {
    expect(
      violations(
        'reader.ts',
        `
      const rows = state.agentStatusByPaneKey
      rows.get(key)
      rows.has(key)
      const output = [...rows.values()]
      function fixture() { const rows = {}; rows[key] = entry; return Object.entries(rows) }
    `
      )
    ).toEqual([])
  })
})
