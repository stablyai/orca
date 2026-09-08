import { describe, expect, it } from 'vitest'
import { EnsureAgentSessionParams } from './agent-session'

/**
 * `startupShell` lets the client tell the host which shell the pane runs, so a
 * per-tab override survives an app restart (#12320, #13095). The field is
 * optional: an older client omits it and the host keeps resolving the shell
 * from the global `terminalWindowsShell` setting.
 */
describe('ensureAgentSession startupShell', () => {
  const base = {
    kind: 'explicit' as const,
    worktree: 'C:/repo',
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id: 'sess-1234' }
  }

  it('accepts every startup-shell family', () => {
    for (const startupShell of ['posix', 'powershell', 'cmd'] as const) {
      expect(EnsureAgentSessionParams.safeParse({ ...base, startupShell }).success).toBe(true)
    }
  })

  it('accepts a request without the field', () => {
    expect(EnsureAgentSessionParams.safeParse(base).success).toBe(true)
  })

  it('rejects a shell name outside the union', () => {
    for (const startupShell of ['fish', 'PowerShell', '', 'bash']) {
      expect(EnsureAgentSessionParams.safeParse({ ...base, startupShell }).success).toBe(false)
    }
  })
})
