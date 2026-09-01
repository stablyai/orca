// Mobile/paired-web remove-only env replay (§581): a captured entry survives only
// when the current live definition still authorizes it (syncEnv on) with the same
// key (case-insensitive on Windows) and the same value. Removed keys, rotated
// values, opt-out, and deleted definitions withhold entries and raise env_withheld;
// current values are never substituted and new current entries never added.
import { describe, expect, it } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import { resolveMobileRemoveOnlyReplayEnv } from './resolve-agent-launch-snapshot-comparison'
import type { LaunchTarget } from './resolve-agent-launch-result'
import { catalogOf, customAgent, customId, settingsOf } from './agent-launch-test-catalog'
import type { CustomTuiAgent } from '../../shared/types'

const AGENT_ID = customId('claude')

function targetOf(platform: NodeJS.Platform = 'linux'): LaunchTarget {
  return {
    platform,
    execution: 'native',
    shell: 'posix',
    isRemote: false,
    executionHostId: 'local'
  }
}

function snapshotOf(agentEnv: Record<string, string>): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: AGENT_ID,
    baseAgent: 'claude',
    displayLabel: 'My Agent',
    mode: 'custom',
    argv: ['claude'] as AgentLaunchSnapshot['argv'],
    agentEnv,
    capturedEnvPolicy: Object.keys(agentEnv).length > 0 ? 'full' : 'none',
    target: {
      platform: 'linux',
      execution: 'native',
      shell: 'posix',
      isRemote: false,
      executionHostId: 'local'
    }
  }
}

function replayEnv(args: {
  agentEnv: Record<string, string>
  definition?: Partial<CustomTuiAgent>
  omitDefinition?: boolean
  platform?: NodeJS.Platform
}) {
  const custom = args.omitDefinition
    ? []
    : [
        customAgent({
          id: AGENT_ID,
          label: 'My Agent',
          env: { API_KEY: 'v1' },
          syncEnv: true,
          ...args.definition
        })
      ]
  return resolveMobileRemoveOnlyReplayEnv({
    snapshot: snapshotOf(args.agentEnv),
    catalog: catalogOf({ customTuiAgents: custom }),
    settings: settingsOf(),
    target: targetOf(args.platform),
    client: 'mobile',
    variables: {},
    targetHomePath: '/home/dev'
  })
}

describe('resolveMobileRemoveOnlyReplayEnv', () => {
  it('keeps a captured entry the current definition still authorizes unchanged', () => {
    expect(replayEnv({ agentEnv: { API_KEY: 'v1' } })).toEqual({
      env: { API_KEY: 'v1' },
      withheld: false
    })
  })

  it('withholds a captured entry whose current value was rotated', () => {
    expect(
      replayEnv({ agentEnv: { API_KEY: 'v1' }, definition: { env: { API_KEY: 'v2' } } })
    ).toEqual({
      env: {},
      withheld: true
    })
  })

  it('withholds every entry when the definition opted out of env sync', () => {
    expect(replayEnv({ agentEnv: { API_KEY: 'v1' }, definition: { syncEnv: false } })).toEqual({
      env: {},
      withheld: true
    })
  })

  it('withholds only the removed key and keeps the still-authorized one', () => {
    expect(
      replayEnv({ agentEnv: { API_KEY: 'v1', EXTRA: 'e' }, definition: { env: { API_KEY: 'v1' } } })
    ).toEqual({ env: { API_KEY: 'v1' }, withheld: true })
  })

  it('never adds a current entry that is absent from the snapshot', () => {
    const result = replayEnv({
      agentEnv: { API_KEY: 'v1' },
      definition: { env: { API_KEY: 'v1', NEW_KEY: 'n' } }
    })
    expect(result).toEqual({ env: { API_KEY: 'v1' }, withheld: false })
    expect(result.env.NEW_KEY).toBeUndefined()
  })

  it('withholds all entries when the definition is deleted/unavailable', () => {
    expect(replayEnv({ agentEnv: { API_KEY: 'v1' }, omitDefinition: true })).toEqual({
      env: {},
      withheld: true
    })
  })

  it('matches keys case-insensitively on Windows, preserving captured key casing', () => {
    expect(
      replayEnv({
        agentEnv: { Api_Key: 'v1' },
        definition: { env: { API_KEY: 'v1' } },
        platform: 'win32'
      })
    ).toEqual({ env: { Api_Key: 'v1' }, withheld: false })
  })

  it('does not match keys case-insensitively off Windows', () => {
    expect(
      replayEnv({ agentEnv: { Api_Key: 'v1' }, definition: { env: { API_KEY: 'v1' } } })
    ).toEqual({ env: {}, withheld: true })
  })
})
