import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orcadNodeRuntimeInstallOptions } from '../ssh/orcad-node-runtime-install-options'
import {
  prefetchWslNodeRuntime,
  resetWslNodeRuntimePrefetchForTests,
  wireWslNodeRuntimePrefetch,
  wslNodeRuntimePrefetchTarget,
  type WslNodeRuntimePrefetchWiring
} from './wsl-node-runtime-prefetch'

type Listener = Parameters<WslNodeRuntimePrefetchWiring['store']['onSettingsChanged']>[0]

let userDataPath: string

beforeEach(async () => {
  resetWslNodeRuntimePrefetchForTests()
  userDataPath = await mkdtemp(join(tmpdir(), 'orca-wsl-node-prefetch-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(userDataPath, { recursive: true, force: true })
})

function fakeStore(enabled: boolean) {
  const listeners: Listener[] = []
  let current = enabled
  return {
    store: {
      getSettings: () => ({ experimentalWslHosts: current }),
      onSettingsChanged: (listener: Listener) => {
        listeners.push(listener)
      }
    },
    set(next: boolean) {
      current = next
      for (const listener of listeners) {
        listener({ experimentalWslHosts: next }, { experimentalWslHosts: next })
      }
    }
  }
}

function wire(options: { enabled: boolean; gateOpen: boolean }) {
  const settings = fakeStore(options.enabled)
  const scheduled: (() => void)[] = []
  const materialize = vi.fn(async () => 'archive')
  wireWslNodeRuntimePrefetch({
    userDataPath,
    arch: 'x64',
    materialize,
    store: settings.store,
    gateOpen: () => options.gateOpen,
    schedule: (run) => scheduled.push(run)
  })
  return { settings, scheduled, materialize }
}

describe('wireWslNodeRuntimePrefetch', () => {
  it('skips the download when the setting turned off before the delay ended, and reschedules on turn-on', async () => {
    const { settings, scheduled, materialize } = wire({ enabled: true, gateOpen: true })
    settings.set(false)
    scheduled[0]()
    expect(materialize).not.toHaveBeenCalled()
    settings.set(true)
    expect(scheduled).toHaveLength(2)
    scheduled[1]()
    await prefetchWslNodeRuntime({ userDataPath })
    expect(materialize).toHaveBeenCalledTimes(1)
  })
})

describe('prefetchWslNodeRuntime', () => {
  it('shares one download between concurrent callers', async () => {
    let finish: (path: string) => void = () => {}
    const materialize = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    const first = prefetchWslNodeRuntime({ userDataPath, arch: 'arm64', materialize })
    const second = prefetchWslNodeRuntime({ userDataPath, arch: 'arm64', materialize })
    expect(second).toBe(first)
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledTimes(1))
    finish('archive')
    await first
    expect(materialize).toHaveBeenCalledWith(
      'linux-arm64-glibc',
      join(userDataPath, 'orcad-artifacts'),
      {}
    )
  })

  it('swallows a failed download and does not retry it this run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const materialize = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND nodejs.org')
    })
    await expect(prefetchWslNodeRuntime({ userDataPath, materialize })).resolves.toBeUndefined()
    await prefetchWslNodeRuntime({ userDataPath, materialize })
    expect(materialize).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('a first connect downloads it'))
  })

  it('skips the download when the deploy cache already has the archive', async () => {
    const target = wslNodeRuntimePrefetchTarget('x64')
    // The path a WSL deploy names as its offline archive is the one the prefetch fills.
    const cached = orcadNodeRuntimeInstallOptions(
      target,
      join(userDataPath, 'orcad-artifacts'),
      {}
    ).nodeRuntimeOfflineArchivePath
    await mkdir(dirname(cached), { recursive: true })
    await writeFile(cached, 'archive')
    const materialize = vi.fn(async () => cached)
    await prefetchWslNodeRuntime({ userDataPath, arch: 'x64', materialize })
    expect(materialize).not.toHaveBeenCalled()
  })
})
