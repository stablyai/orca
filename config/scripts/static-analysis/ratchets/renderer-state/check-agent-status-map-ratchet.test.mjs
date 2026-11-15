import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { collect, violations } from './check-agent-status-map-ratchet.mjs'

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
  it('rejects Map aliases in parameters, bindings and a contextually typed returned factory', () => {
    const text = `
      type Rows = ReadonlyMap<string, AgentStatusEntry>
      type Alias = Rows
      function direct(rows: Alias) { return Object.values(rows) }
      function factory(): (rows: Alias) => unknown {
        return (rows) => Object.entries(rows)
      }
      const annotated: Alias = input
      annotated[key]
      function record(rows: Record<string, AgentStatusEntry>) { return Object.entries(rows) }
    `
    expect(violations('reader.ts', text).map((failure) => failure.split(' ')[1])).toEqual([
      'Object.values',
      'Object.entries',
      'bracket'
    ])
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr41793-map-guard-'))
    try {
      execFileSync('git', ['init', '-q', root])
      fs.mkdirSync(path.join(root, 'src/renderer/src'), { recursive: true })
      fs.writeFileSync(path.join(root, 'src/renderer/src/reader.ts'), text)
      expect(collect(root)).toHaveLength(3)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
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
