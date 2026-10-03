import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import type { WslResult, WslSpec } from '../wsl/wsl-runner'
import {
  WSL_CLAUDE_PROFILE_POINTER,
  WSL_CLAUDE_PROFILE_POINTER_FROM_HOME
} from '../../shared/claude-profile-routing'
const mocks = vi.hoisted(() => ({
  root: '',
  running: true,
  runningChecks: 0,
  run: vi.fn<(spec: WslSpec) => Promise<WslResult>>(),
  runtime: vi.fn()
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getAppPath: () => mocks.root, getPath: () => mocks.root })
}))
vi.mock('../wsl/wsl-relay-bundle-dirs', () => ({ wslRelayBundleDirs: () => [mocks.root] }))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: async (paths: string[]) => {
    mocks.runningChecks += 1
    return mocks.running ? paths : []
  }
}))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.run }))
vi.mock('../wsl/wsl-pinned-runtime', () => ({ ensureWslPinnedRuntime: mocks.runtime }))
import {
  prepareClaudeWslGuest,
  waitForRunningWslDistro,
  withdrawClaudeWslPointer
} from './claude-profile-wsl-transport'
import {
  ClaudeProfileHostMissingError,
  ClaudeProfileHostUnreachableError
} from './claude-profile-routing-owner'
import { WSL_CLAUDE_PROFILE_HELPER_FILENAME } from '../../shared/relay-artifacts'
const EXECUTABLE = '/home/fake/.cache/orca/runtimes/pinned/bin/node'
const helperCalls = () => mocks.run.mock.calls.filter(([spec]) => spec.program === '/usr/bin/env')
const helperInput = () => JSON.parse(helperCalls().at(-1)?.[0].input ?? '{}')
beforeEach(() => {
  mocks.root = mkdtempSync(join(tmpdir(), 'fake-wsl-'))
  mocks.running = true
  mocks.runningChecks = 0
  mocks.run.mockReset().mockImplementation(async (spec) => {
    let stdout = '/mnt/c/fake-helper.cjs'
    if (spec.program === '/usr/bin/env') {
      stdout = JSON.stringify({ ready: true, provisioned: true })
    } else if (spec.args?.[0] === '-c') {
      const script = spec.args[1] ?? ''
      const begin = script.match(/__ORCA_WSL_CAPTURE_BEGIN_[a-z0-9]+__/)?.[0]
      const end = script.match(/__ORCA_WSL_CAPTURE_END_[a-z0-9]+__/)?.[0]
      stdout = `guest banner\n${begin}2.1.0 (Claude Code)${end}`
    }
    return { code: 0, stdout, stderr: '', timedOut: false, environmentResolved: true }
  })
  mocks.runtime.mockReset().mockImplementation(async (run) => {
    for (const program of ['uname', 'getconf', 'printf', 'probe']) {
      await run({ program, loginPath: 'none' })
    }
    return { executable: EXECUTABLE, home: '/home/fake' }
  })
  writeFileSync(join(mocks.root, WSL_CLAUDE_PROFILE_HELPER_FILENAME), 'FAKE BUNDLE')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(mocks.root, { recursive: true, force: true })
})
const setup = (home: string) =>
  ({
    action: 'setup',
    distro: 'Ubuntu with spaces',
    userHome: home,
    accountId: 'a',
    hooksEnabled: true
  }) as const
it('runs the helper through the WSL runner with literal argv, stdin JSON and a fenced version probe', async () => {
  const guest = await prepareClaudeWslGuest('Ubuntu with spaces')
  await guest.request(setup(guest.home))
  expect(helperCalls().at(-1)?.[0]).toMatchObject({
    distro: 'Ubuntu with spaces',
    loginPath: 'none',
    args: ['-u', 'NODE_OPTIONS', EXECUTABLE, '/mnt/c/fake-helper.cjs']
  })
  expect(helperInput()).toMatchObject({ action: 'setup', claudeVersion: '2.1.0' })
  expect(
    mocks.run.mock.calls.some(([spec]) => spec.args?.[1]?.includes('__ORCA_WSL_CAPTURE_BEGIN_'))
  ).toBe(true)
})
it('refuses stopped distros before any guest command and again before each request', async () => {
  mocks.running = false
  await expect(prepareClaudeWslGuest('Stopped')).rejects.toBeInstanceOf(
    ClaudeProfileHostUnreachableError
  )
  expect(mocks.run).not.toHaveBeenCalled()
  mocks.running = true
  const guest = await prepareClaudeWslGuest('Ubuntu')
  mocks.running = false
  await expect(
    guest.request({
      action: 'publish',
      distro: 'Ubuntu',
      userHome: guest.home,
      accountId: 'a',
      hooksEnabled: false
    })
  ).rejects.toThrow('not running')
  expect(helperCalls()).toHaveLength(0)
})
it('surfaces runtime and process failures without substituting a personal Claude launch', async () => {
  mocks.runtime.mockRejectedValueOnce(new Error('download refused'))
  await expect(prepareClaudeWslGuest('Ubuntu')).rejects.toThrow('download refused')
  const guest = await prepareClaudeWslGuest('Ubuntu')
  mocks.run.mockResolvedValue({
    code: 1,
    stdout: '',
    stderr: 'pinned runtime missing\r\n',
    timedOut: false,
    environmentResolved: true
  })
  await expect(
    guest.request({
      action: 'publish',
      distro: 'Ubuntu',
      userHome: guest.home,
      accountId: 'a',
      hooksEnabled: false
    })
  ).rejects.toThrow(/^WSL Claude profile refused: pinned runtime missing$/)
})
it('keeps a cached guest usable after its preparation deadline has passed', async () => {
  const deadline = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  const guest = await prepareClaudeWslGuest('Ubuntu with spaces')
  deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
  await expect(guest.request(setup(guest.home))).resolves.toMatchObject({ ready: true })
  expect(helperInput().claudeVersion).toBe('2.1.0')
})
it('continues setup with an unknown Claude version when the guest probe fails, like native', async () => {
  const guest = await prepareClaudeWslGuest('Ubuntu with spaces')
  const helper = mocks.run.getMockImplementation()
  if (!helper) {
    throw new Error('The default WSL runner mock is missing')
  }
  mocks.run.mockImplementation(async (spec) =>
    spec.program === '/bin/sh'
      ? {
          code: 127,
          stdout: '',
          stderr: 'claude: not found',
          timedOut: false,
          environmentResolved: true
        }
      : helper(spec)
  )
  await expect(guest.request(setup(guest.home))).resolves.toMatchObject({ ready: true })
  expect(helperInput()).not.toHaveProperty('claudeVersion')
})
it('confirms the distro is running once per preparation and once per request', async () => {
  const guest = await prepareClaudeWslGuest('Ubuntu')
  expect({ checks: mocks.runningChecks, commands: mocks.run.mock.calls.length }).toEqual({
    checks: 1,
    commands: 5
  })
  await guest.request({
    action: 'inspect',
    distro: 'Ubuntu',
    userHome: guest.home,
    accountId: 'a',
    hooksEnabled: false
  })
  expect({ checks: mocks.runningChecks, commands: mocks.run.mock.calls.length }).toEqual({
    checks: 2,
    commands: 6
  })
  await guest.request({ ...setup(guest.home), distro: 'Ubuntu' })
  expect({ checks: mocks.runningChecks, commands: mocks.run.mock.calls.length }).toEqual({
    checks: 3,
    commands: 8
  })
})

it('withdraws a stale pointer even without a usable pinned runtime', async () => {
  mocks.runtime.mockRejectedValue(new Error('missing runtime'))
  await withdrawClaudeWslPointer('Ubuntu')
  expect(mocks.runtime).not.toHaveBeenCalled()
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({
      distro: 'Ubuntu',
      loginPath: 'none',
      script: `rm -f -- "$HOME/${WSL_CLAUDE_PROFILE_POINTER_FROM_HOME}"`
    })
  )
  expect(WSL_CLAUDE_PROFILE_POINTER).toBe(`~/${WSL_CLAUDE_PROFILE_POINTER_FROM_HOME}`)
})
it('waits a few seconds for a booting distro, probing sparingly, then gives up', async () => {
  vi.useFakeTimers()
  try {
    mocks.running = false
    const stays = waitForRunningWslDistro('Ubuntu')
    await vi.advanceTimersByTimeAsync(7_000)
    await expect(stays).resolves.toBe(false)
    expect(mocks.runningChecks).toBe(3)
    const boots = waitForRunningWslDistro('Ubuntu')
    await vi.advanceTimersByTimeAsync(1_000)
    mocks.running = true
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(boots).resolves.toBe(true)
    expect(mocks.runningChecks).toBe(5)
    expect(mocks.run).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
it('lets user-initiated work boot a stopped distro instead of checking it is running first', async () => {
  mocks.running = false
  const guest = await prepareClaudeWslGuest('Ubuntu', 'boot')
  await guest.request(
    {
      action: 'publish',
      distro: 'Ubuntu',
      userHome: guest.home,
      accountId: 'a',
      hooksEnabled: false
    },
    'boot'
  )
  await withdrawClaudeWslPointer('Ubuntu', 'boot')
  expect(mocks.runningChecks).toBe(0)
  expect(helperCalls()).toHaveLength(1)
  await expect(withdrawClaudeWslPointer('Ubuntu')).rejects.toThrow('not running')
  expect(mocks.runningChecks).toBe(1)
})
it("classifies wsl.exe's own missing-distro failure and reports its diagnostic", async () => {
  const hostFailure = (stdout: string) => ({
    code: 0xffffffff,
    stdout,
    stderr: '',
    timedOut: false,
    environmentResolved: true
  })
  mocks.run.mockResolvedValueOnce(
    hostFailure(
      'There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n'
    )
  )
  await expect(prepareClaudeWslGuest('Gone', 'boot')).rejects.toBeInstanceOf(
    ClaudeProfileHostMissingError
  )
  mocks.run.mockResolvedValueOnce(
    hostFailure(
      'The virtual machine could not be started.\r\nError code: Wsl/Service/WSL_E_VM_FAILED\r\n'
    )
  )
  const error = await prepareClaudeWslGuest('Broken', 'boot').catch((caught) => caught)
  expect(error).not.toBeInstanceOf(ClaudeProfileHostMissingError)
  expect(String(error)).toContain('WSL_E_VM_FAILED')
})
