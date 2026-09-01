import { describe, expect, it } from 'vitest'
import {
  agentLaunchExecutionHostDisplayName,
  buildPendingAgentLaunchSummary
} from './agent-launch-pending-summary-host'
import type { AdmissionCapacityRow } from './agent-launch-admission-store'

function row(over: Partial<AdmissionCapacityRow>): AdmissionCapacityRow {
  return {
    intent: 'cli',
    scope: 'wt-1',
    admittedAt: 1,
    launchToken: 'secret-tok',
    baseHarness: 'codex',
    executionHostId: 'local',
    ...over
  }
}

describe('agentLaunchExecutionHostDisplayName', () => {
  it('labels local, ssh (alias then id fallback), wsl distro, and runtime env', () => {
    expect(agentLaunchExecutionHostDisplayName('local', () => undefined)).toBeTruthy()
    expect(
      agentLaunchExecutionHostDisplayName('ssh:prod', (t) =>
        t === 'prod' ? 'Prod box' : undefined
      )
    ).toBe('Prod box')
    expect(agentLaunchExecutionHostDisplayName('ssh:prod', () => undefined)).toBe('prod')
    // wsl:${encodeURIComponent(distro)} — decoded back to the distro name.
    expect(agentLaunchExecutionHostDisplayName('wsl:My%20Distro', () => undefined)).toBe(
      'My Distro'
    )
    expect(agentLaunchExecutionHostDisplayName('runtime:env-9', () => undefined)).toBe('env-9')
  })

  it('never returns a path-shaped value for a display name', () => {
    for (const id of ['local', 'ssh:prod', 'wsl:Ubuntu', 'runtime:env-1'] as const) {
      expect(agentLaunchExecutionHostDisplayName(id, () => undefined)).not.toContain('/')
    }
  })
})

describe('buildPendingAgentLaunchSummary', () => {
  it('projects redacted rows and never emits the host-private launch token', () => {
    const result = buildPendingAgentLaunchSummary(
      [
        row({
          launchToken: 'secret-tok',
          scope: 'wt-1',
          intent: 'cli',
          baseHarness: 'codex',
          admittedAt: 42
        })
      ],
      {
        resolveLiveness: () => 'live',
        resolveDeepLink: (r) => ({ kind: 'worktree', worktreeId: r.scope }),
        sshLabelFor: () => undefined
      }
    )
    expect(result.rows[0]).toEqual({
      sourceKind: 'cli',
      baseHarness: 'codex',
      targetHostDisplayName: expect.any(String),
      admittedAt: 42,
      liveness: 'live',
      deepLink: { kind: 'worktree', worktreeId: 'wt-1' }
    })
    // The launch token is host-private and must never reach the client DTO.
    expect(result.rows[0]).not.toHaveProperty('launchToken')
    expect(JSON.stringify(result)).not.toContain('secret-tok')
  })

  it('omits deepLink when no owner resolves and passes injected liveness through', () => {
    const result = buildPendingAgentLaunchSummary([row({})], {
      resolveLiveness: () => 'absent',
      resolveDeepLink: () => undefined,
      sshLabelFor: () => undefined
    })
    expect(result.rows[0]).not.toHaveProperty('deepLink')
    expect(result.rows[0].liveness).toBe('absent')
  })
})
