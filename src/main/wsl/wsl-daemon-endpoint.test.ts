import { PROTOCOL_VERSION } from '../daemon/daemon-protocol-version'
import { proveWslDaemonIncarnationExited } from './wsl-daemon-incarnation'
import { beforeEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { prepareWslGuestOwner } from './wsl-guest-owner-preparation'
import {
  prepareWslDaemonEndpoint,
  startPreparedWslDaemonOwner,
  startRetainedWslDaemonOwner
} from './wsl-daemon-endpoint'
import { createRunningWslRuntimeRunner } from './wsl-bun-runtime'
import { readWslDistributionIdentity } from './wsl-distribution-identity'

vi.mock('./wsl-daemon-incarnation', () => ({ proveWslDaemonIncarnationExited: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
vi.mock('../daemon/daemon-bun-runtime', () => ({
  desktopDaemonBundleDir: () => '/app/terminal-daemon'
}))
vi.mock('./wsl-guest-owner-preparation', () => ({ prepareWslGuestOwner: vi.fn() }))
vi.mock('./wsl-bun-runtime', () => ({ createRunningWslRuntimeRunner: vi.fn() }))
vi.mock('./wsl-distribution-identity', () => ({ readWslDistributionIdentity: vi.fn() }))
const run = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  run.mockImplementation(async (spec) =>
    spec.program === 'wslpath' ? '/mnt/app/terminal-daemon' : 'ready'
  )
  vi.mocked(readFile).mockResolvedValue(Buffer.from('daemon-artifact'))
  vi.mocked(readWslDistributionIdentity).mockResolvedValue('registered-distro')
  const execution = { run, signal: new AbortController().signal }
  vi.mocked(createRunningWslRuntimeRunner).mockReturnValue(execution)
  vi.mocked(prepareWslGuestOwner).mockResolvedValue({
    distributionId: 'registered-distro',
    userName: 'captured',
    userId: '1000',
    platform: 'linux-x64',
    libc: 'glibc',
    runtime: '/private/bun',
    execution,
    environment: { home: '/home/u', path: '/usr/bin', envBinary: '/usr/bin/env' }
  })
})

it('installs only the daemon bundle with captured-owner guards and a private token path', async () => {
  const prepared = await prepareWslDaemonEndpoint('Ubuntu', 'profile')
  const command = run.mock.calls.find(([spec]) => spec.program === '/usr/bin/env')?.[0]
  const plan = JSON.parse(command.args.at(-1))
  expect(plan.files).toEqual([
    { name: 'daemon-entry.js', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }
  ])
  expect(plan).toMatchObject({
    userId: '1000',
    home: '/home/u',
    source: '/mnt/app/terminal-daemon'
  })
  expect(command.args).toEqual(
    expect.arrayContaining(['--no-env-file', '--config=/dev/null', '--no-install'])
  )
  expect(prepared.endpoint).toMatchObject({
    userName: 'captured',
    distributionId: 'registered-distro',
    protocolVersion: PROTOCOL_VERSION
  })
  expect(prepared.endpoint.tokenPath).toBe(`${plan.ownerDirectory}/token`)
  expect(Object.isFrozen(prepared.endpoint)).toBe(true)
})

it('keeps profiles and changed artifact contents on independent endpoints', async () => {
  const first = await prepareWslDaemonEndpoint('Ubuntu', 'first')
  const otherProfile = await prepareWslDaemonEndpoint('Ubuntu', 'second')
  expect(otherProfile.entry).toBe(first.entry)
  expect(otherProfile.endpoint.socket).not.toBe(first.endpoint.socket)
  vi.mocked(readFile).mockResolvedValue(Buffer.from('new-daemon'))
  const changed = await prepareWslDaemonEndpoint('Ubuntu', 'first')
  expect(changed.entry).not.toBe(first.entry)
  expect(changed.endpoint.socket).not.toBe(first.endpoint.socket)
})

it('never launches after the registered distro is replaced', async () => {
  const prepared = await prepareWslDaemonEndpoint('Ubuntu', 'profile')
  run.mockClear()
  vi.mocked(readWslDistributionIdentity).mockResolvedValue('different-distro')
  await expect(startPreparedWslDaemonOwner(prepared)).rejects.toThrow('replaced')
  expect(run).not.toHaveBeenCalled()
})

it('launches through the captured user and accepts only confirmed readiness', async () => {
  const prepared = await prepareWslDaemonEndpoint('Ubuntu', 'profile')
  run.mockResolvedValue('started')
  await startPreparedWslDaemonOwner(prepared)
  expect(run.mock.lastCall?.[0].args).toEqual(
    expect.arrayContaining(['--no-env-file', '--config=/dev/null', '--no-install'])
  )
  expect(createRunningWslRuntimeRunner).toHaveBeenCalledWith('ubuntu', undefined, 'captured')
  run.mockResolvedValue('incomplete')
  await expect(startPreparedWslDaemonOwner(prepared)).rejects.toThrow('could not be started')
})

it('uses independent fresh endpoints for renamed users or changed environment executables', async () => {
  const first = await prepareWslDaemonEndpoint('Ubuntu', 'profile')
  const initial = await prepareWslGuestOwner('Ubuntu')
  vi.mocked(prepareWslGuestOwner).mockResolvedValue({ ...initial, userName: 'renamed' })
  const renamed = await prepareWslDaemonEndpoint('Ubuntu', 'profile')
  expect(renamed.owner.relayBuildId).not.toBe(first.owner.relayBuildId)
  expect(renamed.endpoint.socket).not.toBe(first.endpoint.socket)
  vi.mocked(prepareWslGuestOwner).mockResolvedValue({
    ...initial,
    environment: { ...initial.environment, envBinary: '/opt/homebrew/bin/env' }
  })
  const changed = await prepareWslDaemonEndpoint('Ubuntu', 'profile')
  expect(changed.owner.relayBuildId).not.toBe(first.owner.relayBuildId)
  expect(changed.endpoint.socket).not.toBe(first.endpoint.socket)
  expect(first.endpoint.userName).toBe('captured')
  expect(first.endpoint.envBinary).toBe('/usr/bin/env')
})

it('canonicalizes fresh distro aliases without modifying persisted reconnect identities', async () => {
  const first = await prepareWslDaemonEndpoint('Ubuntu', 'profile')
  const alias = await prepareWslDaemonEndpoint('ubuntu', 'profile')
  expect(alias).toEqual(first)
  expect(alias.owner.distro).toBe('ubuntu')
})

it('checks old process death before starting the retained artifact after bundle replacement', async () => {
  const old = await prepareWslDaemonEndpoint('Ubuntu', 'profile')
  vi.mocked(readFile).mockResolvedValue(Buffer.from('new-daemon'))
  const current = await prepareWslDaemonEndpoint('Ubuntu', 'profile')
  expect(current.endpoint.entry).not.toBe(old.endpoint.entry)
  const incarnation = {
    pid: 42,
    startedAtMs: 100,
    launchNonce: 'old',
    linuxStartTicks: '123',
    bootId: 'boot'
  }
  run.mockClear().mockResolvedValue('started')
  vi.mocked(proveWslDaemonIncarnationExited).mockRejectedValueOnce(new Error('still live'))
  await expect(startRetainedWslDaemonOwner(old.endpoint, incarnation)).rejects.toThrow('still live')
  expect(run).not.toHaveBeenCalled()
  vi.mocked(proveWslDaemonIncarnationExited).mockResolvedValue(undefined)
  await startRetainedWslDaemonOwner(old.endpoint, incarnation)
  expect(proveWslDaemonIncarnationExited).toHaveBeenLastCalledWith(
    old.endpoint,
    incarnation,
    undefined
  )
  expect(JSON.parse(run.mock.lastCall?.[0].args.at(-1))).toEqual(old.endpoint)
  expect(createRunningWslRuntimeRunner).toHaveBeenLastCalledWith('ubuntu', undefined, 'captured')
})
