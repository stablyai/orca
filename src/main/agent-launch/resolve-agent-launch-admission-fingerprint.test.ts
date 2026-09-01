// The admission fingerprint must move whenever anything that changes THIS launch
// changes — including the env a mobile/paired remove-only replay actually ships,
// which the coarse capture policy alone cannot distinguish. The config-only
// stable digest must stay blind to the path variables (and to the argv/env values
// they are substituted into) so the two-stage worktree recheck still passes.
import { describe, expect, it } from 'vitest'
import { resolveAgentLaunch } from './resolve-agent-launch'
import {
  catalogOf,
  customAgent,
  customId,
  requestOf,
  settingsOf
} from './agent-launch-test-catalog'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { ResolveAgentLaunchOutcome } from './resolve-agent-launch'

const AGENT_ID = customId('claude', '00000000-0000-4000-8000-0000000f0001')

const CAPTURED_ENV = { API_KEY: 'v1', REGION: 'eu' }

function snapshotOf(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: AGENT_ID,
    baseAgent: 'claude',
    displayLabel: 'My Agent',
    mode: 'custom',
    argv: ['claude'] as unknown as AgentLaunchSnapshot['argv'],
    agentEnv: CAPTURED_ENV,
    capturedEnvPolicy: 'full',
    target: {
      platform: 'linux',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    }
  }
}

/** A mobile replay of the same snapshot against a live definition whose env may
 *  have rotated since capture. */
function mobileReplay(definitionEnv: Record<string, string>): ResolveAgentLaunchOutcome {
  return resolveAgentLaunch(
    {
      ...requestOf({ selection: { kind: 'agent', agent: AGENT_ID } }),
      intent: { kind: 'resume', operation: 'resume', client: 'mobile' },
      reference: { kind: 'persisted', owner: 'session' },
      persistedSnapshot: snapshotOf()
    },
    catalogOf({
      customTuiAgents: [
        customAgent({
          id: AGENT_ID,
          label: 'My Agent',
          env: definitionEnv,
          syncEnv: true
        })
      ]
    }),
    settingsOf()
  )
}

function launchOf(outcome: ResolveAgentLaunchOutcome) {
  if (!outcome.ok || !('launch' in outcome)) {
    throw new Error('expected the launch to resolve')
  }
  return outcome.launch
}

describe('admission fingerprint over replay env authorization', () => {
  it('differs when a rotated key is withheld, though every coarse input matches', () => {
    const authorized = launchOf(mobileReplay({ API_KEY: 'v1', REGION: 'eu' }))
    const rotated = launchOf(mobileReplay({ API_KEY: 'v2', REGION: 'eu' }))
    expect(authorized.agentEnv).toEqual(CAPTURED_ENV)
    expect(rotated.agentEnv).toEqual({ REGION: 'eu' })
    // Same argv, same capture policy ('full' — one entry survived), same replay
    // definition digest: only the shipped env moved, so only it can carry the
    // difference. A stale admission would otherwise ship the pre-rotation value.
    expect(authorized.policy.env).toBe(rotated.policy.env)
    expect(authorized.admissionGuard.fingerprint).not.toBe(rotated.admissionGuard.fingerprint)
  })

  it('stays identical for two replays that ship the same env', () => {
    const first = launchOf(mobileReplay({ API_KEY: 'v1', REGION: 'eu' }))
    const second = launchOf(mobileReplay({ API_KEY: 'v1', REGION: 'eu' }))
    expect(first.admissionGuard.fingerprint).toBe(second.admissionGuard.fingerprint)
  })

  it('differs when a per-launch arg changes the resolved argv', () => {
    const argvFingerprint = (args: string): string => {
      const outcome = resolveAgentLaunch(
        requestOf({ selection: { kind: 'agent', agent: AGENT_ID } }),
        catalogOf({ customTuiAgents: [customAgent({ id: AGENT_ID, args })] }),
        settingsOf()
      )
      return launchOf(outcome).admissionGuard.fingerprint
    }
    expect(argvFingerprint('--model a')).not.toBe(argvFingerprint('--model b'))
  })
})

describe('config-only stable digest', () => {
  function resolveAtWorktree(worktreePath: string): ResolveAgentLaunchOutcome {
    return resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: AGENT_ID },
        variables: { repoPath: '/repo', worktreePath }
      }),
      catalogOf({
        customTuiAgents: [
          customAgent({
            id: AGENT_ID,
            args: '{worktreePath}',
            env: { WT: '{worktreePath}' }
          })
        ]
      }),
      settingsOf()
    )
  }

  it('ignores the paths substituted into argv and env so stage 2 rechecks cleanly', () => {
    const provisional = launchOf(resolveAtWorktree('/wt-provisional'))
    const authoritative = launchOf(resolveAtWorktree('/wt-real'))
    expect(provisional.argv).toContain('/wt-provisional')
    expect(authoritative.agentEnv.WT).toBe('/wt-real')
    expect(provisional.admissionGuard.fingerprint).not.toBe(
      authoritative.admissionGuard.fingerprint
    )
    expect(provisional.admissionGuard.stableInputDigest).toBe(
      authoritative.admissionGuard.stableInputDigest
    )
  })
})
