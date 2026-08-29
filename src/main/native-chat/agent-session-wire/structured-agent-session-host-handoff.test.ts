import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { structuredTuiTranscriptImportOptions } from './structured-agent-session-host-handoff'

function importRecord(provider: 'claude' | 'codex', accountHome: string): AgentSessionRecord {
  return {
    provider,
    accountHome: {
      variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: accountHome
    }
  } as AgentSessionRecord
}

describe('structured TUI transcript import roots', () => {
  it('uses the managed Claude account home when no live transcript path remains', () => {
    expect(structuredTuiTranscriptImportOptions(importRecord('claude', '/managed/claude'))).toEqual(
      {
        claudeProjectsDir: join('/managed/claude', 'projects')
      }
    )
  })

  it('uses the managed Codex account home when no live transcript path remains', () => {
    expect(structuredTuiTranscriptImportOptions(importRecord('codex', '/managed/codex'))).toEqual({
      codexSessionsDirs: [join('/managed/codex', 'sessions')]
    })
  })
})
