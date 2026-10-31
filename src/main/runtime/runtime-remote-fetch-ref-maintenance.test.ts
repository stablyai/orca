import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fetches suppress auto-maintenance and create loose refs; pin controller scheduling and its per-repo busy signal.

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
  it('does not collapse every repo onto one key on Git older than 2.31', async () => {
    // Older Git may echo unsupported --path-format and exit 0; do not mistake its relative .git answer for every repo's key.
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) =>
      argv[0] === 'rev-parse'
        ? { stdout: '--path-format=absolute\n.git\n', stderr: '' }
        : { stdout: '', stderr: '' }
    )
    const controller = new RuntimeRemoteFetchController()

    await controller.getOrStartRemoteFetch('/repo/one', 'origin')
    await controller.getOrStartRemoteFetch('/repo/two', 'origin')

    await vi.waitFor(() =>
      expect(armedTargets().map((entry) => entry.key)).toEqual([
        'local::/repo/one/.git',
        'local::/repo/two/.git'
      ])
    )
  })

  it('reports the repo as busy while another fetch on it is in flight', async () => {
    const controller = new RuntimeRemoteFetchController()
    await controller.getOrStartRemoteFetch('/repo', 'first')
    await vi.waitFor(() => expect(busyProbeFor('local::/repo/.git')).toBeDefined())
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
})
