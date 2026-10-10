import { beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { probeOpenCodeCliVersion } from './opencode-cli-version'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
beforeEach(() => vi.mocked(runProcess).mockReset())

it('shares concurrent probes and isolates executable, host and environment identities', async () => {
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '1.1.23',
    stderr: '',
    timedOut: false
  })
  const options = {
    executablePath: '/test/opencode',
    env: { PATH: '/runtime', XDG_CONFIG_HOME: '/one' },
    hostIdentity: 'native'
  }
  const results = await Promise.all([
    probeOpenCodeCliVersion(options),
    probeOpenCodeCliVersion(options)
  ])
  expect(results[0].pluginApi).toBe('v1')
  expect(runProcess).toHaveBeenCalledTimes(1)
  await probeOpenCodeCliVersion({ ...options, executablePath: '/other/opencode' })
  await probeOpenCodeCliVersion({ ...options, hostIdentity: 'wsl:ubuntu' })
  await probeOpenCodeCliVersion({ ...options, env: { ...options.env, XDG_CONFIG_HOME: '/two' } })
  expect(runProcess).toHaveBeenCalledTimes(4)
  expect(runProcess).toHaveBeenCalledWith(
    expect.objectContaining({ args: ['--version'], timeoutMs: 5_000, maxOutputBytes: 4_096 })
  )
})

it('degrades timeouts and missing executables to unknown', async () => {
  vi.mocked(runProcess).mockResolvedValueOnce({
    code: null,
    signal: 'SIGTERM',
    stdout: '2.0.16',
    stderr: '',
    timedOut: true
  })
  expect(
    (await probeOpenCodeCliVersion({ executablePath: '/timeout/opencode', env: {} })).pluginApi
  ).toBe('unknown')
  vi.mocked(runProcess).mockRejectedValueOnce(new Error('ENOENT'))
  expect(
    (await probeOpenCodeCliVersion({ executablePath: '/missing/opencode', env: {} })).version
  ).toBeNull()
})

it('shares a bounded execution-host callback without probing the native machine', async () => {
  const execute = vi
    .fn()
    .mockResolvedValue({ code: 0, timedOut: false, stdout: 'opencode v2.0.16' })
  const options = { executablePath: 'opencode', env: {}, hostIdentity: 'wsl:private', execute }
  const results = await Promise.all([
    probeOpenCodeCliVersion(options),
    probeOpenCodeCliVersion(options)
  ])
  expect(results[0].promptMode).toBe('prefill')
  expect(execute).toHaveBeenCalledTimes(1)
  expect(runProcess).not.toHaveBeenCalled()
})

it('shares probes across pane identities while preserving launch-affecting environment keys', async () => {
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '2.0.16',
    stderr: '',
    timedOut: false
  })
  const options = {
    executablePath: '/pane-cache/opencode',
    cwd: '/workspace',
    env: {
      PATH: '/runtime',
      OPENCODE_CONFIG_DIR: '/config',
      ORCA_PANE_KEY: 'pane-1',
      ORCA_TAB_ID: 'tab-1',
      ORCA_TERMINAL_HANDLE: 'term-1',
      ORCA_WORKTREE_ID: 'workspace-1',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
      ORCA_AGENT_PANE: 'pane-1',
      ORCA_AGENT_LAUNCH: 'launch-1'
    },
    hostIdentity: 'pane-cache-host'
  }
  await Promise.all([
    probeOpenCodeCliVersion(options),
    probeOpenCodeCliVersion({
      ...options,
      env: {
        ...options.env,
        ORCA_PANE_KEY: 'pane-2',
        ORCA_TAB_ID: 'tab-2',
        ORCA_TERMINAL_HANDLE: 'term-2',
        ORCA_WORKTREE_ID: 'workspace-2',
        ORCA_AGENT_LAUNCH_TOKEN: 'launch-2',
        ORCA_AGENT_PANE: 'pane-2',
        ORCA_AGENT_LAUNCH: 'launch-2'
      }
    })
  ])
  expect(runProcess).toHaveBeenCalledTimes(1)
  await probeOpenCodeCliVersion({ ...options, env: { ...options.env, PATH: '/other-runtime' } })
  await probeOpenCodeCliVersion({
    ...options,
    env: { ...options.env, OPENCODE_CONFIG_DIR: '/other-config' }
  })
  await probeOpenCodeCliVersion({ ...options, cwd: '/other-workspace' })
  expect(runProcess).toHaveBeenCalledTimes(4)
})

it('separates native and host-callback backends even with the same host identity', async () => {
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '1.18.32',
    stderr: '',
    timedOut: false
  })
  const options = { executablePath: '/backend/opencode', env: {}, hostIdentity: 'backend-host' }
  expect((await probeOpenCodeCliVersion(options)).pluginApi).toBe('v1')
  const execute = vi.fn(async () => ({ code: 0, timedOut: false, stdout: '2.0.16' }))
  expect((await probeOpenCodeCliVersion({ ...options, execute })).pluginApi).toBe('v2')
  expect(execute).toHaveBeenCalledOnce()
  expect(runProcess).toHaveBeenCalledOnce()
})
