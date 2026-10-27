import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'

function record(provider: string, saved: Record<string, string> | undefined): AgentSessionRecord {
  const { permissionMode, ...options } = saved ?? {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch mode reads only the record's id, agent, options and mode.
  return { sessionId: 'session-1', provider, options, permissionMode } as AgentSessionRecord
}

function launchPermission(provider: string, options?: Record<string, string>) {
  return structuredAgentSessionLaunchPermission(
    { agents: claudeAndCodexDeclared() },
    record(provider, options)
  )
}

describe('the permission mode a chat starts with', () => {
  it('delegates saved own settings', async () => {
    for (const provider of ['claude', 'codex']) {
      await expect(launchPermission(provider, { permissionMode: 'own' })).resolves.toBe('own')
    }
  })

  it('has none for an unregistered agent or one with no modes', async () => {
    await expect(launchPermission('grok', { permissionMode: 'full-access' })).resolves.toBe(null)
    await expect(launchPermission('pi', { permissionMode: 'full-access' })).resolves.toBe(null)
  })
})
