import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { resolveAgentForegroundProcessFromPs } from './agent-foreground-process'

type CapturedRun = {
  agent: string
  shellPid: number
  rows: ProcessTableRow[]
}

describe('real foreground process captures', () => {
  it('resolves all six agents, including omp over its deeper vendor helpers', () => {
    const captured = JSON.parse(
      gunzipSync(readFileSync(join(__dirname, '__fixtures__', 'real-agent-rows.json.gz'))).toString(
        'utf8'
      )
    ) as CapturedRun[]

    expect(captured).toHaveLength(6)
    expect(
      captured.map(({ agent, shellPid, rows }) => ({
        agent,
        processName: resolveAgentForegroundProcessFromPs(rows, shellPid)
      }))
    ).toEqual([
      { agent: 'claude', processName: 'claude' },
      { agent: 'codex', processName: 'codex' },
      { agent: 'opencode', processName: 'opencode' },
      { agent: 'gemini', processName: 'gemini' },
      { agent: 'grok', processName: 'grok' },
      { agent: 'omp', processName: 'omp' }
    ])
  })
})
