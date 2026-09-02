import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { spawnSourceControlAgent } from './source-control-agent-launch'

vi.mock('../../shared/child-process/run-process', () => ({
  spawnProcess: vi.fn(() => ({ stdin: { on: vi.fn(), end: vi.fn() } }))
}))
vi.mock('../git/runner', () => ({ wslAwareSpawn: vi.fn() }))

const PANE_IDENTITY_ENV = {
  ORCA_PANE_KEY: 'tab:leaf',
  ORCA_TAB_ID: 'tab',
  ORCA_WORKTREE_ID: 'repo::/w',
  ORCA_AGENT_LAUNCH_TOKEN: 'token'
}

function lastSpawnEnv(): NodeJS.ProcessEnv {
  return vi.mocked(spawnProcess).mock.calls.at(-1)?.[0].env ?? {}
}

describe('spawnSourceControlAgent pane identity', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('strips inherited pane identity from an explicit env', () => {
    spawnSourceControlAgent({
      binary: 'claude',
      args: ['-p'],
      cwd: '/tmp',
      env: { ...PANE_IDENTITY_ENV, KEEP_ME: '1', PATH: '/usr/bin' },
      stdinMode: 'ignore',
      useCwdForNative: true
    })
    const env = lastSpawnEnv()
    // Why: a headless generation run must not look like a pane session, or the
    // agent's Stop hook reports "finished" to a live Orca pane and notifies.
    for (const key of Object.keys(PANE_IDENTITY_ENV)) {
      expect(env).not.toHaveProperty(key)
    }
    expect(env.KEEP_ME).toBe('1')
  })

  it('strips inherited pane identity from the process env fallback', () => {
    for (const [key, value] of Object.entries(PANE_IDENTITY_ENV)) {
      vi.stubEnv(key, value)
    }
    spawnSourceControlAgent({
      binary: 'claude',
      args: ['-p'],
      cwd: '/tmp',
      stdinMode: 'ignore',
      useCwdForNative: true
    })
    const env = lastSpawnEnv()
    for (const key of Object.keys(PANE_IDENTITY_ENV)) {
      expect(env).not.toHaveProperty(key)
    }
  })
})
