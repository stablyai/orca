import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: Orca's fetches are what create the loose-ref backlog (they suppress
// git's auto-maintenance), so the fetch controller is where the idle sweep has
// to be armed. These tests pin that wiring and the per-repo busy signal it
// hands the sweep.

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
const armMock = vi.hoisted(() => vi.fn())
const busyProbeMock = vi.hoisted(() => vi.fn())

vi.mock('../git/runner', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../git/local-repo-ref-maintenance', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  armLocalRepoRefMaintenance: armMock,
  setRepoRefMaintenanceBusyProbe: busyProbeMock
}))

import { _resetCanonicalRepoKeyCacheForTests } from '../git/canonical-repo-key'
import { RuntimeRemoteFetchController } from './runtime-remote-fetch-controller'

function armedTargets(): { key: string }[] {
  return armMock.mock.calls.map(([args]) => args as { key: string })
}

/** The per-repo "a fetch is in flight" answer the controller registers for a key. */
function busyProbeFor(key: string): (() => boolean) | undefined {
  return busyProbeMock.mock.calls.findLast(([registered]) => registered === key)?.[1] as
    | (() => boolean)
    | undefined
}

beforeEach(() => {
  _resetCanonicalRepoKeyCacheForTests()
  gitExecFileAsyncMock.mockReset()
  armMock.mockReset()
  busyProbeMock.mockReset()
  gitExecFileAsyncMock.mockImplementation(async (argv: string[]) =>
    argv[0] === 'rev-parse' ? { stdout: '/repo/.git\n', stderr: '' } : { stdout: '', stderr: '' }
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetch-armed ref maintenance', () => {
  it('arms the sweep for the repo after a remote fetch, keyed by common dir', async () => {
    const controller = new RuntimeRemoteFetchController()

    await controller.getOrStartRemoteFetch('/repo/worktrees/a', 'origin')

    expect(armedTargets().map((target) => target.key)).toEqual(['local::/repo/.git'])
  })

  it('gives every worktree of one repo the same maintenance key', async () => {
    const controller = new RuntimeRemoteFetchController()

    await controller.getOrStartRemoteFetch('/repo/worktrees/a', 'origin')
    await controller.getOrStartRemoteTrackingBaseRefresh('/repo/worktrees/b', {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    })

    const keys = new Set(armedTargets().map((target) => target.key))
    expect(keys).toEqual(new Set(['local::/repo/.git']))
  })

  it('scopes the key to the WSL distro that executes the repo', async () => {
    const controller = new RuntimeRemoteFetchController()

    await controller.getOrStartRemoteFetch('//wsl$/Ubuntu/repo', 'origin', {
      wslDistro: 'Ubuntu'
    })

    expect(armedTargets()[0]?.key).toBe('wsl:Ubuntu::/repo/.git')
  })

  it('does not collapse every repo onto one key on Git older than 2.31', async () => {
    // Old Git echoes the unrecognized `--path-format` flag, exits 0, and prints a
    // relative `.git`; taking that raw would name every repository identically.
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) =>
      argv[0] === 'rev-parse'
        ? { stdout: '--path-format=absolute\n.git\n', stderr: '' }
        : { stdout: '', stderr: '' }
    )
    const controller = new RuntimeRemoteFetchController()

    await controller.getOrStartRemoteFetch('/repo/one', 'origin')
    await controller.getOrStartRemoteFetch('/repo/two', 'origin')

    expect(armedTargets().map((entry) => entry.key)).toEqual([
      'local::/repo/one/.git',
      'local::/repo/two/.git'
    ])
  })

  it('reports the repo as busy while another fetch on it is in flight', async () => {
    const controller = new RuntimeRemoteFetchController()
    await controller.getOrStartRemoteFetch('/repo', 'first')
    const isBusy = busyProbeFor('local::/repo/.git')
    expect(isBusy?.()).toBe(false)

    let releaseFetch: (() => void) | undefined
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      await new Promise<void>((resolve) => {
        releaseFetch = resolve
      })
      return { stdout: '', stderr: '' }
    })
    const second = controller.getOrStartRemoteFetch('/repo', 'second')
    await vi.waitFor(() => expect(releaseFetch).toBeDefined())
    expect(isBusy?.()).toBe(true)

    releaseFetch?.()
    await second
    expect(isBusy?.()).toBe(false)
  })

  it('arms even when the fetch fails, because a partial fetch still writes refs', async () => {
    const controller = new RuntimeRemoteFetchController()
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      throw new Error('network is unreachable')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(controller.getOrStartRemoteFetch('/repo', 'origin')).resolves.toEqual({
      ok: false,
      errorKind: 'git_error'
    })
    expect(armedTargets()).toHaveLength(1)
  })
})
