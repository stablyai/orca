import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { prewarmClaudeCliFlags } from './claude-cli-flag-prewarm'

const record = (
  sessionId: string,
  overrides: {
    provider?: string
    host?: ExecutionHostId
    wslDistro?: string | null
    dir?: string
  } = {}
): AgentSessionRecord =>
  agentSessionRecordFixture({
    sessionId,
    provider: overrides.provider ?? 'claude',
    location: {
      executionHostId: overrides.host ?? LOCAL_EXECUTION_HOST_ID,
      wslDistro: overrides.wslDistro ?? null
    },
    ...(overrides.dir ? { launchDirectory: overrides.dir } : {})
  })

function prewarmWith(records: AgentSessionRecord[], resolveCommand = () => '/bin/claude') {
  const prewarm = vi.fn()
  const done = prewarmClaudeCliFlags({
    cliFlags: { prewarm },
    store: {
      listVisibleSessionIds: () => records.map((r) => r.sessionId),
      getRecord: (id) => records.find((r) => r.sessionId === id) ?? null
    },
    resolveCommand,
    resolveEnv: () => ({ PATH: '/shims' }),
    resolveInheritedEnv: async () => ({ PATH: '/usr/bin' })
  })
  return { prewarm, done }
}

describe('prewarming the Claude version check at startup', () => {
  it("probes the home folder and each open local Claude chat's own folder, a few at most", async () => {
    const { prewarm, done } = prewarmWith([
      record('a', { dir: '/scratch/a' }),
      record('codex', { provider: 'codex', dir: '/scratch/codex' }),
      record('remote', { host: 'ssh:box', dir: '/scratch/remote' }),
      record('wsl', { wslDistro: 'Ubuntu', dir: '/scratch/wsl' }),
      record('b', { dir: '/scratch/b' }),
      record('unpinned'),
      record('c', { dir: '/scratch/c' }),
      record('d', { dir: '/scratch/d' })
    ])
    await done
    expect(prewarm.mock.calls.map(([launch]) => launch.cwd)).toEqual([
      homedir(),
      '/scratch/a',
      '/scratch/b',
      '/scratch/c'
    ])
    expect(prewarm.mock.calls[0]?.[0]).toMatchObject({ command: '/bin/claude' })
  })

  it('never throws when the CLI cannot be resolved', async () => {
    const { prewarm, done } = prewarmWith([], () => {
      throw new Error('the claude Command setting is not a runnable program')
    })
    await expect(done).resolves.toBeUndefined()
    expect(prewarm).not.toHaveBeenCalled()
  })
})
