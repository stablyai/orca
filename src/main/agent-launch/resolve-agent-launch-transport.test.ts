// Confidential-transport gating: env-bearing cross-host resolution requires an
// authenticated AND confidential channel; env-free launches may continue over a
// merely-authenticated one, and env is never silently dropped to make a launch
// succeed.
import { describe, expect, it } from 'vitest'
import { resolveAgentLaunch } from './resolve-agent-launch'
import {
  catalogOf,
  customAgent,
  customId,
  requestOf,
  settingsOf
} from './agent-launch-test-catalog'

const AGENT_ID = customId('codex')

function envBearingCatalog() {
  return catalogOf({
    customTuiAgents: [
      customAgent({ id: AGENT_ID, baseAgent: 'codex', label: 'Env Codex', env: { API_KEY: 'v' } })
    ]
  })
}

function envFreeCatalog() {
  return catalogOf({
    customTuiAgents: [customAgent({ id: AGENT_ID, baseAgent: 'codex', label: 'Plain Codex' })]
  })
}

describe('secure env transport gating', () => {
  it('fails env-bearing resolution when the channel is authenticated but not confidential', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: AGENT_ID },
        isRemote: true,
        executionHostId: 'ssh:host-1',
        transportConfidentialityAvailable: false
      }),
      envBearingCatalog(),
      settingsOf()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok || !('failure' in outcome)) {
      return
    }
    expect(outcome.failure.code).toBe('secure_env_transport_unavailable')
    // The failure never downgrades to an env-free launch or leaks env content.
    expect(JSON.stringify(outcome)).not.toContain('API_KEY')
  })

  it('allows env-bearing resolution over a confidential channel', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: AGENT_ID },
        isRemote: true,
        executionHostId: 'ssh:host-1',
        transportConfidentialityAvailable: true
      }),
      envBearingCatalog(),
      settingsOf()
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.launch.agentEnv).toEqual({ API_KEY: 'v' })
  })

  it('allows an env-free launch over a non-confidential channel', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: AGENT_ID },
        isRemote: true,
        executionHostId: 'ssh:host-1',
        transportConfidentialityAvailable: false
      }),
      envFreeCatalog(),
      settingsOf()
    )
    expect(outcome.ok).toBe(true)
  })

  it('treats an undefined capability as same-host and does not gate', () => {
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'agent', agent: AGENT_ID } }),
      envBearingCatalog(),
      settingsOf()
    )
    expect(outcome.ok).toBe(true)
  })

  it('fails env-bearing resolution on a remote target when confidentiality is unproven', () => {
    // A remote surface that never threaded the capability must fail closed rather
    // than ship env over a possibly-plaintext channel; only `=== true` allows it.
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: AGENT_ID },
        isRemote: true,
        executionHostId: 'ssh:host-1'
      }),
      envBearingCatalog(),
      settingsOf()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok || !('failure' in outcome)) {
      return
    }
    expect(outcome.failure.code).toBe('secure_env_transport_unavailable')
  })

  it('gates snapshot replay carrying captured env the same way', () => {
    const confidential = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: AGENT_ID },
        isRemote: true,
        executionHostId: 'ssh:host-1',
        transportConfidentialityAvailable: true
      }),
      envBearingCatalog(),
      settingsOf()
    )
    expect(confidential.ok).toBe(true)
    if (!confidential.ok) {
      return
    }
    const replay = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: AGENT_ID },
        isRemote: true,
        executionHostId: 'ssh:host-1',
        transportConfidentialityAvailable: false,
        persistedSnapshot: confidential.launch.snapshot
      }),
      envBearingCatalog(),
      settingsOf()
    )
    expect(replay.ok).toBe(false)
    if (replay.ok || !('failure' in replay)) {
      return
    }
    expect(replay.failure.code).toBe('secure_env_transport_unavailable')
  })
})
