import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetHydrateShellPathCache,
  hydrateShellPath,
  mergePathSegments
} from './hydrate-shell-path'

describe('hydrateShellPath', () => {
  const originalPath = process.env.PATH

  beforeEach(() => {
    _resetHydrateShellPathCache()
  })

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  })

  it('invokes the provided shell with a custom spawner and returns its segments', async () => {
    let capturedShell = ''
    const result = await hydrateShellPath({
      shellOverride: '/bin/zsh',
      spawner: async (shell) => {
        capturedShell = shell
        return {
          segments: ['/Users/tester/.opencode/bin', '/Users/tester/.cargo/bin'],
          ok: true
        }
      }
    })

    expect(capturedShell).toBe('/bin/zsh')
    expect(result.ok).toBe(true)
    expect(result.segments).toEqual(['/Users/tester/.opencode/bin', '/Users/tester/.cargo/bin'])
  })

  it('caches the hydration result so repeated calls do not re-spawn', async () => {
    let spawnCount = 0
    const spawner = async (): Promise<{ segments: string[]; ok: boolean }> => {
      spawnCount += 1
      return { segments: ['/a'], ok: true }
    }

    await hydrateShellPath({ shellOverride: '/bin/zsh', spawner })
    await hydrateShellPath({ shellOverride: '/bin/zsh', spawner })
    await hydrateShellPath({ shellOverride: '/bin/zsh', spawner })

    expect(spawnCount).toBe(1)
  })

  it('re-spawns when force:true is passed — matches the Refresh button contract', async () => {
    let spawnCount = 0
    const spawner = async (): Promise<{ segments: string[]; ok: boolean }> => {
      spawnCount += 1
      return { segments: ['/a'], ok: true }
    }

    await hydrateShellPath({ shellOverride: '/bin/zsh', spawner })
    await hydrateShellPath({ shellOverride: '/bin/zsh', spawner, force: true })

    expect(spawnCount).toBe(2)
  })

  it('returns ok:false when no shell is available (Windows path)', async () => {
    const result = await hydrateShellPath({
      shellOverride: null,
      spawner: async () => {
        throw new Error('spawner must not run when shell is null')
      }
    })

    expect(result).toEqual({ segments: [], ok: false })
  })
})

describe('mergePathSegments', () => {
  const originalPath = process.env.PATH

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
  })

  it('prepends new segments ahead of existing PATH entries', () => {
    process.env.PATH = '/usr/bin:/bin'

    const added = mergePathSegments(['/Users/tester/.opencode/bin', '/Users/tester/.cargo/bin'])

    expect(added).toEqual(['/Users/tester/.opencode/bin', '/Users/tester/.cargo/bin'])
    expect(process.env.PATH).toBe(
      '/Users/tester/.opencode/bin:/Users/tester/.cargo/bin:/usr/bin:/bin'
    )
  })

  it('skips segments already on PATH so re-hydration is a no-op', () => {
    process.env.PATH = '/Users/tester/.cargo/bin:/usr/bin'

    const added = mergePathSegments(['/Users/tester/.cargo/bin', '/Users/tester/.opencode/bin'])

    expect(added).toEqual(['/Users/tester/.opencode/bin'])
    expect(process.env.PATH).toBe('/Users/tester/.opencode/bin:/Users/tester/.cargo/bin:/usr/bin')
  })

  it('returns [] and leaves PATH untouched when given nothing', () => {
    process.env.PATH = '/usr/bin:/bin'

    expect(mergePathSegments([])).toEqual([])
    expect(process.env.PATH).toBe('/usr/bin:/bin')
  })
})
