import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { launchWslBrowserNetworkRelay } from './wsl-browser-network-relay-launch'
import {
  WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME,
  WSL_BROWSER_NETWORK_RELAY_VERSION_FILE
} from '../../shared/wsl-browser-network-relay-contract'

const mocks = vi.hoisted(() => ({ running: vi.fn(), prepare: vi.fn(), spawn: vi.fn() }))
vi.mock('../wsl/wsl-bun-runtime', () => ({
  assertWslRuntimeDistroRunning: mocks.running,
  createRunningWslRuntimeRunner: vi.fn(),
  ensureWslBunRuntime: mocks.prepare
}))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: mocks.spawn }))
let directory: string
beforeEach(async () => {
  vi.resetAllMocks()
  directory = await mkdtemp(join(tmpdir(), 'orca-browser-running-'))
  const bundle = join(directory, 'wsl')
  await mkdir(bundle)
  await writeFile(join(bundle, WSL_BROWSER_NETWORK_RELAY_BUNDLE_NAME), '// fixture')
  await writeFile(join(bundle, WSL_BROWSER_NETWORK_RELAY_VERSION_FILE), '1.0.0')
  vi.stubEnv('ORCA_RELAY_PATH', directory)
  mocks.prepare.mockResolvedValue('/guest/bun')
  mocks.running.mockResolvedValue(undefined)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

it('does not launch if the distro stopped during runtime preparation', async () => {
  mocks.running.mockRejectedValueOnce(new Error('distro stopped'))
  await expect(
    launchWslBrowserNetworkRelay('Ubuntu', new AbortController().signal)
  ).rejects.toThrow('distro stopped')
  expect(mocks.prepare).toHaveBeenCalledOnce()
  expect(mocks.spawn).not.toHaveBeenCalled()
})

it('does not install into a distro that stopped after a stale launch', async () => {
  mocks.running.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('distro stopped'))
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  mocks.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit('close', 42))
    return child
  })
  await expect(
    launchWslBrowserNetworkRelay('Ubuntu', new AbortController().signal)
  ).rejects.toThrow('distro stopped')
  expect(mocks.spawn).toHaveBeenCalledOnce()
  expect(mocks.running).toHaveBeenCalledTimes(2)
})
