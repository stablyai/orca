import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The gate's running reads go through wsl.exe; these tests feed the cache their own lists.
vi.mock('../wsl', () => ({ listRunningWslDistrosAsync: vi.fn(), listWslDistrosAsync: vi.fn() }))

import {
  _resetWslBackgroundDistroGateForTests,
  noteWslDistroMayHaveStopped,
  WSL_STOP_SETTLE_MS
} from '../wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../wsl-running-distro-cache'
import {
  followWslAutomountRoots,
  knownWslAutomountRoots,
  onWslAutomountRootsChanged,
  parseWslAutomountRoot,
  resetWslAutomountRootsForTests
} from './wsl-automount-root'

let now = 1_000
const unfollows: (() => void)[] = []

function follow(read: (distro: string) => Promise<string | null>): void {
  unfollows.push(followWslAutomountRoots(() => ['Ubuntu'], read))
}

/** One confirmed running-distro list, probed at the current test clock. */
async function listRunning(distros: string[]): Promise<void> {
  await resolveRunningWslDistros(async () => distros)
}

beforeEach(() => {
  now = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
})

afterEach(() => {
  // The real cache keeps its listeners across tests.
  unfollows.splice(0).forEach((unfollow) => unfollow())
  resetWslAutomountRootsForTests()
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  vi.restoreAllMocks()
})

describe('parseWslAutomountRoot', () => {
  it.each([
    ['/mnt/c/', '/mnt/'],
    ['/c/', '/'],
    ['/windows/c', '/windows/'],
    ['not a path', null],
    [null, null]
  ])('%s → %s', (value, expected) => {
    expect(parseWslAutomountRoot(value)).toBe(expected)
  })
})

describe('followWslAutomountRoots', () => {
  it("reads a project distro's root once it runs, and again after it restarts", async () => {
    const read = vi.fn(async () => '/')
    const changed = vi.fn()
    onWslAutomountRootsChanged(changed)
    follow(read)
    await listRunning(['Ubuntu', 'Debian'])
    await vi.waitFor(() => expect(knownWslAutomountRoots()).toEqual(['/mnt/', '/']))
    // Only the project distros, and only once while it runs.
    await listRunning(['Ubuntu'])
    expect(read).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    expect(changed).toHaveBeenCalledOnce()
    await listRunning([])
    expect(knownWslAutomountRoots()).toEqual(['/mnt/'])
    await listRunning(['Ubuntu'])
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  })

  it('never reads from a list probed while the distro was still stopping, only from a settled one', async () => {
    const read = vi.fn(async () => '/')
    follow(read)
    noteWslDistroMayHaveStopped('Ubuntu')
    // wsl.exe still lists a terminating distro; reading its root now would boot it again.
    now += WSL_STOP_SETTLE_MS - 1
    await listRunning(['Ubuntu'])
    expect(read).not.toHaveBeenCalled()

    now += 1
    await listRunning(['Ubuntu'])
    expect(read).toHaveBeenCalledExactlyOnceWith('Ubuntu')
  })

  it('keeps the default root when a distro cannot be read', async () => {
    const read = vi.fn(async () => null)
    follow(read)
    await listRunning(['Ubuntu'])
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    expect(knownWslAutomountRoots()).toEqual(['/mnt/'])
  })
})

describe('followWslAutomountRoots: one guest read per distro start', () => {
  /** Settles the reads one confirmed list started before the next probe. */
  async function observeRunning(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      await listRunning(['Ubuntu'])
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  it.each(['/mnt/', '/custom/'])(
    'reads a %s root once across many running observations, and once more after a restart',
    async (root) => {
      let reads = 0
      follow(async () => {
        reads += 1
        return root
      })
      await observeRunning(10)
      expect(reads).toBe(1)

      await listRunning([])
      await observeRunning(10)
      expect(reads).toBe(2)
    }
  )

  it('retries a read that failed or found nothing, then stops once one succeeds', async () => {
    const results: (string | null | Error)[] = [new Error('wsl.exe timed out'), null, '/mnt/']
    let reads = 0
    follow(async () => {
      const result = reads < results.length ? results[reads] : '/mnt/'
      reads += 1
      if (result instanceof Error) {
        throw result
      }
      return result
    })
    await observeRunning(6)
    expect(reads).toBe(3)
  })

  it('reads again after a restart even when the stop came while a read was in flight', async () => {
    let reads = 0
    let finishFirst: (root: string) => void = () => {}
    follow(
      (): Promise<string> =>
        new Promise((resolve) => {
          reads += 1
          if (reads === 1) {
            finishFirst = resolve
          } else {
            resolve('/mnt/')
          }
        })
    )
    await listRunning(['Ubuntu'])
    await listRunning([])
    finishFirst('/mnt/')
    await new Promise((resolve) => setImmediate(resolve))
    await observeRunning(3)
    expect(reads).toBe(2)
  })
})
