import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installAgentApiKeyLaunchEnvResolver } from './agent-api-key-launch-env'
import {
  forgetAgentApiKeyHostCapabilities,
  withAgentApiKeyRuntimeEnv
} from './agent-api-key-runtime-call'

const KEY = { ANTHROPIC_API_KEY: 'sk-ant-api03-runtime-call-test' }

function call(method: string, params: unknown, capabilities: string[] = []) {
  return [
    'env-1',
    method,
    params,
    vi.fn(async () => ({
      id: 'status.get',
      ok: true as const,
      result: { capabilities },
      _meta: { runtimeId: 'r' }
    }))
  ] as const
}

beforeEach(() => {
  installAgentApiKeyLaunchEnvResolver(async (agent, hostId) =>
    agent === 'claude' && hostId === 'runtime:env-1' ? KEY : {}
  )
})

afterEach(() => {
  installAgentApiKeyLaunchEnvResolver(null)
  forgetAgentApiKeyHostCapabilities('env-1')
})

describe('withAgentApiKeyRuntimeEnv', () => {
  it('adds keys to a caller-built agent launch, letting the caller’s env win', async () => {
    const params = await withAgentApiKeyRuntimeEnv(
      ...call('terminal.create', {
        launchAgent: 'claude',
        command: 'claude',
        env: { ANTHROPIC_API_KEY: 'from-command-override', FOO: '1' }
      })
    )
    expect(params).toMatchObject({ env: { ANTHROPIC_API_KEY: 'from-command-override', FOO: '1' } })

    const fresh = await withAgentApiKeyRuntimeEnv(
      ...call('session.tabs.createTerminal', { launchAgent: 'claude', command: 'claude' })
    )
    expect(fresh).toMatchObject({ env: KEY })
  })

  it('leaves plain shells, other agents and unrelated methods alone', async () => {
    for (const [method, params] of [
      ['terminal.create', { command: undefined }],
      ['terminal.create', { launchAgent: 'claude' }],
      ['terminal.create', { launchAgent: 'codex', command: 'codex' }],
      ['terminal.send', { agent: 'claude', text: 'hi' }]
    ] as const) {
      expect(await withAgentApiKeyRuntimeEnv(...call(method, params))).toBe(params)
    }
  })

  it('sends keyEnv on host-built launches only to hosts that advertise it', async () => {
    const params = { agent: 'claude', worktree: 'id:w' }
    expect(await withAgentApiKeyRuntimeEnv(...call('terminal.createAgentSession', params))).toBe(
      params
    )
    forgetAgentApiKeyHostCapabilities('env-1')
    expect(
      await withAgentApiKeyRuntimeEnv(
        ...call('terminal.ensureAgentSession', { ...params, kind: 'explicit' }, [
          'agent-session.key-env.v1'
        ])
      )
    ).toMatchObject({ keyEnv: KEY })
    expect(
      await withAgentApiKeyRuntimeEnv(
        ...call('terminal.ensureAgentSession', { kind: 'automatic', sleepingCheckpointId: 'c' })
      )
    ).not.toHaveProperty('keyEnv')
  })
})
