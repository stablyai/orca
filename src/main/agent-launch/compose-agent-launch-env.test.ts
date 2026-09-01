import { describe, expect, it } from 'vitest'
import type { CustomTuiAgentId } from '../../shared/types'
import { resolveAgentLaunch, type ResolveAgentLaunchOutcome } from './resolve-agent-launch'
import {
  composeAgentLaunchEnv,
  measurePosixArgEnvBytes,
  measureWindowsEnvironmentBlockCodeUnits,
  ORCA_PROTECTED_ENV_KEYS
} from './compose-agent-launch-env'
import { checkEnvPayloadTooLarge } from './agent-launch-payload-caps'
import {
  catalogOf,
  customAgent,
  customId,
  requestOf,
  settingsOf
} from './agent-launch-test-catalog'

const CID: CustomTuiAgentId = customId('claude', '00000000-0000-4000-8000-0000000000e1')

function envOf(outcome: ResolveAgentLaunchOutcome): Record<string, string> {
  if (!outcome.ok) {
    throw new Error(`expected launch, got ${JSON.stringify(outcome)}`)
  }
  return { ...outcome.launch.agentEnv }
}

describe('composeAgentLaunchEnv layering', () => {
  it('merges Path/PATH case variants case-insensitively on win32, last layer wins', () => {
    const env = composeAgentLaunchEnv({
      platform: 'win32',
      inherited: { Path: 'a' },
      agentEnv: { PATH: 'b' }
    })
    const keys = Object.keys(env)
    expect(keys).toEqual(['PATH'])
    expect(env.PATH).toBe('b')
  })

  it('keeps distinct-case keys separate on posix', () => {
    const env = composeAgentLaunchEnv({
      platform: 'linux',
      inherited: { Path: 'a' },
      agentEnv: { PATH: 'b' }
    })
    expect(env.Path).toBe('a')
    expect(env.PATH).toBe('b')
  })

  it('regenerates every protected-key case variant last', () => {
    const env = composeAgentLaunchEnv({
      platform: 'linux',
      inherited: { orca_pane_key: 'spoof', ORCA_PANE_KEY: 'stale', Orca_Pane_Key: 'stale2' },
      orcaControl: { ORCA_PANE_KEY: 'fresh' }
    })
    const paneKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'orca_pane_key')
    expect(paneKeys).toEqual(['ORCA_PANE_KEY'])
    expect(env.ORCA_PANE_KEY).toBe('fresh')
  })

  it('deletes an inherited protected key even without a fresh replacement', () => {
    const env = composeAgentLaunchEnv({
      platform: 'linux',
      inherited: { ORCA_AGENT_HOOK_TOKEN: 'stale' }
    })
    expect(env.ORCA_AGENT_HOOK_TOKEN).toBeUndefined()
  })

  it('recomputes shadow keys from the effective user env before protected keys', () => {
    const env = composeAgentLaunchEnv({
      platform: 'linux',
      agentEnv: { CODEX_HOME: '/custom' },
      deriveShadowKeys: (effective) => ({ ORCA_CODEX_HOME_SHADOW: effective.CODEX_HOME ?? '' })
    })
    expect(env.ORCA_CODEX_HOME_SHADOW).toBe('/custom')
  })

  it('never inherits a protected key from a user-overridable provider key list', () => {
    for (const key of ORCA_PROTECTED_ENV_KEYS) {
      expect(key.startsWith('ORCA_')).toBe(true)
    }
  })
})

describe('resolver env admission', () => {
  it('a custom launch never inherits base agentDefaultEnv', () => {
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'agent', agent: CID } }),
      catalogOf({ customTuiAgents: [customAgent({ id: CID, env: { BAR: '2' } })] }),
      settingsOf({ agentDefaultEnv: { claude: { FOO: '1' } } })
    )
    const env = envOf(outcome)
    expect(env).toEqual({ BAR: '2' })
    expect(env.FOO).toBeUndefined()
  })

  it('a safe-fallback launch carries no env at all', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: CID },
        intent: { kind: 'interactive', client: 'desktop' },
        reference: { kind: 'persisted', owner: 'default' }
      }),
      catalogOf({
        customTuiAgents: [customAgent({ id: CID, env: { BAR: '2' } })],
        disabledTuiAgents: [CID]
      }),
      settingsOf({ agentDefaultEnv: { claude: { FOO: '1' } } })
    )
    if (!outcome.ok) {
      throw new Error('expected safe-fallback launch')
    }
    expect(Object.keys(outcome.launch.agentEnv)).toEqual([])
    expect(outcome.launch.policy.env).toBe('none')
  })

  it('withholds custom env for a mobile client without syncEnv and surfaces a notice', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: CID },
        intent: { kind: 'interactive', client: 'mobile' }
      }),
      catalogOf({ customTuiAgents: [customAgent({ id: CID, env: { BAR: '2' }, syncEnv: false })] }),
      settingsOf()
    )
    if (!outcome.ok) {
      throw new Error('expected launch')
    }
    expect(Object.keys(outcome.launch.agentEnv)).toEqual([])
    expect(outcome.launch.policy.env).toBe('withheld')
    expect(outcome.launch.notices.map((notice) => notice.code)).toContain('env_withheld')
  })

  it('admits custom env for a mobile client when syncEnv is true', () => {
    const outcome = resolveAgentLaunch(
      requestOf({
        selection: { kind: 'agent', agent: CID },
        intent: { kind: 'interactive', client: 'mobile' }
      }),
      catalogOf({ customTuiAgents: [customAgent({ id: CID, env: { BAR: '2' }, syncEnv: true })] }),
      settingsOf()
    )
    expect(envOf(outcome)).toEqual({ BAR: '2' })
    if (outcome.ok) {
      expect(outcome.launch.policy.env).toBe('full')
    }
  })

  it('reports env policy none for an empty custom env on desktop', () => {
    const outcome = resolveAgentLaunch(
      requestOf({ selection: { kind: 'agent', agent: CID } }),
      catalogOf({ customTuiAgents: [customAgent({ id: CID, env: {} })] }),
      settingsOf()
    )
    if (outcome.ok) {
      expect(outcome.launch.policy.env).toBe('none')
    }
  })
})

describe('env payload caps', () => {
  const posixTarget = {
    platform: 'linux' as NodeJS.Platform,
    execution: 'native' as const,
    isRemote: false
  }
  const winTarget = {
    platform: 'win32' as NodeJS.Platform,
    execution: 'native' as const,
    isRemote: false
  }

  it('measures a native-windows environment block including terminators', () => {
    // "A=b" (3) + entry NUL (1) + final block terminator (1) = 5 code units.
    expect(measureWindowsEnvironmentBlockCodeUnits({ A: 'b' })).toBe(5)
  })

  it('fails closed on an oversized native-windows environment block', () => {
    const env = { BIG: 'x'.repeat(40_000) }
    expect(checkEnvPayloadTooLarge(['claude'], env, winTarget)).toMatchObject({
      code: 'invalid_agent_env',
      reason: 'environment_block_too_large'
    })
  })

  it('fails closed on an oversized POSIX combined argv+env payload', () => {
    const env = { BIG: 'x'.repeat(140_000) }
    expect(measurePosixArgEnvBytes(['claude'], env)).toBeGreaterThan(131_072)
    expect(checkEnvPayloadTooLarge(['claude'], env, posixTarget)).toMatchObject({
      code: 'invalid_agent_env',
      reason: 'arg_env_too_large'
    })
  })

  it('accepts an env within the 16 KiB per-agent bound', () => {
    const env = { OK: 'x'.repeat(8_000) }
    expect(checkEnvPayloadTooLarge(['claude'], env, winTarget)).toBeNull()
    expect(checkEnvPayloadTooLarge(['claude'], env, posixTarget)).toBeNull()
  })
})
