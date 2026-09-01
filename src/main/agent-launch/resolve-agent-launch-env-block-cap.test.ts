// A native-Windows spawn inherits this process' env, so CreateProcess sizes the
// composed inherited+custom block, not the custom layer the resolver admits.
// Measuring only the custom layer admits a launch that then dies opaquely at
// spawn, so the cap composes the real block for that target and no other.
import { describe, expect, it } from 'vitest'
import { resolveAgentLaunch } from './resolve-agent-launch'
import { catalogOf, requestOf, settingsOf } from './agent-launch-test-catalog'
import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'
import type { ResolveAgentLaunchOutcome } from './resolve-agent-launch'

const WINDOWS_TARGET = {
  platform: 'win32' as NodeJS.Platform,
  shell: 'cmd' as const,
  targetHomePath: 'C:\\Users\\me'
}

/** Just past WINDOWS_ENVIRONMENT_BLOCK_MAX_CODE_UNITS once composed. */
const OVERSIZED_INHERITED: NodeJS.ProcessEnv = { HUGE: 'x'.repeat(33_000) }

function resolveWith(
  overrides: Partial<Parameters<typeof requestOf>[0]>,
  inheritedEnv: NodeJS.ProcessEnv
): ResolveAgentLaunchOutcome {
  return resolveAgentLaunch(
    requestOf({ selection: { kind: 'agent', agent: 'claude' }, ...overrides }),
    catalogOf({}),
    settingsOf(),
    inheritedEnv
  )
}

function failureCodeOf(outcome: ResolveAgentLaunchOutcome): string | null {
  return !outcome.ok && 'failure' in outcome ? outcome.failure.code : null
}

describe('native-Windows environment-block cap', () => {
  it('rejects a launch whose inherited block already exceeds the ceiling', () => {
    const outcome = resolveWith({ ...WINDOWS_TARGET }, OVERSIZED_INHERITED)
    expect(failureCodeOf(outcome)).toBe('invalid_agent_env')
    if (!outcome.ok && 'failure' in outcome && outcome.failure.code === 'invalid_agent_env') {
      expect(outcome.failure.reason).toBe('environment_block_too_large')
      expect(outcome.failure.field).toBe('env')
    }
  })

  it('admits the same launch under a normal inherited block', () => {
    expect(resolveWith({ ...WINDOWS_TARGET }, { PATH: 'C:\\bin' }).ok).toBe(true)
  })

  it('ignores the local inherited block for a remote target', () => {
    const outcome = resolveWith(
      {
        isRemote: true,
        targetHomePath: null,
        executionHostId: 'ssh:box' as AgentLaunchExecutionHostId
      },
      OVERSIZED_INHERITED
    )
    expect(outcome.ok).toBe(true)
  })

  it('ignores it for a WSL target, which spawns inside the distro', () => {
    const outcome = resolveWith(
      { ...WINDOWS_TARGET, executionHostId: 'wsl:Ubuntu' as AgentLaunchExecutionHostId },
      OVERSIZED_INHERITED
    )
    expect(outcome.ok).toBe(true)
  })

  it('applies the same ceiling to a snapshot replay', () => {
    const admitted = resolveWith({ ...WINDOWS_TARGET }, { PATH: 'C:\\bin' })
    if (!admitted.ok || !('launch' in admitted)) {
      throw new Error('expected the baseline launch to resolve')
    }
    const replay = resolveAgentLaunch(
      {
        ...requestOf({ selection: { kind: 'agent', agent: 'claude' }, ...WINDOWS_TARGET }),
        intent: { kind: 'resume', operation: 'resume', client: 'desktop' },
        reference: { kind: 'persisted', owner: 'session' },
        persistedSnapshot: admitted.launch.snapshot
      },
      catalogOf({}),
      settingsOf(),
      OVERSIZED_INHERITED
    )
    expect(failureCodeOf(replay)).toBe('invalid_agent_env')
  })
})
