import { describe, expect, it, vi } from 'vitest'
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../wsl/wsl-unc-access-gate'
import {
  stoppedRootReader,
  stoppedWslRootsReadScopeKey,
  unavailableWhileWslDistroStopped
} from './skill-discovery-stopped-wsl-roots'

// Off Windows the real gate never sees a distro; stand in for its UNC parse.
vi.mock('../wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  wslDistroForPath: (path: string) => /^\\\\wsl\.localhost\\([^\\]+)/.exec(path)?.[1] ?? null
}))

const ubuntu = (rest: string): string => `\\\\wsl.localhost\\Ubuntu${rest}`

describe('stoppedRootReader', () => {
  it('reads a root that holds a chosen skill directory, and no other', () => {
    const read = stoppedRootReader([ubuntu('\\home\\me\\.claude\\skills\\alpha')])
    expect(read(ubuntu('\\home\\me\\.claude\\skills'))).toBe(true)
    expect(read(ubuntu('\\HOME\\me\\.claude\\skills\\'))).toBe(true)
    expect(read(ubuntu('\\repo\\.claude\\skills'))).toBe(false)
  })

  it('never lets an empty, `/` or bare share root match every directory', () => {
    const read = stoppedRootReader([ubuntu('\\home\\me\\.claude\\skills\\alpha')])
    expect(read('')).toBe(false)
    expect(read('/')).toBe(false)
    expect(read('\\\\')).toBe(false)
  })

  it('reads every root on the named distros, matching names case-insensitively', () => {
    const read = stoppedRootReader({ distros: ['ubuntu'] })
    expect(read(ubuntu('\\home\\me\\.claude\\plugins\\x\\skills'))).toBe(true)
    expect(read('\\\\wsl.localhost\\Debian\\home\\me\\.claude\\skills')).toBe(false)
    expect(read('C:\\Users\\me\\.claude\\skills')).toBe(false)
  })

  it('keys each scope apart for the scan coalescer', () => {
    const keys = [
      stoppedWslRootsReadScopeKey('all'),
      stoppedWslRootsReadScopeKey({ distros: ['Ubuntu'] }),
      stoppedWslRootsReadScopeKey(['Ubuntu'])
    ]
    expect(new Set(keys).size).toBe(3)
    expect(stoppedWslRootsReadScopeKey({ distros: ['Ubuntu', 'Debian'] })).toBe(
      stoppedWslRootsReadScopeKey({ distros: ['debian', 'ubuntu'] })
    )
  })
})

describe('unavailableWhileWslDistroStopped', () => {
  it.each([new WslDistroStoppedError('Ubuntu'), new WslDistroUnverifiableError('Ubuntu')])(
    'answers no skills and an unavailable source per requested kind for %s',
    async (refusal) => {
      const result = await unavailableWhileWslDistroStopped(
        () => Promise.reject(refusal),
        ['home', 'repo']
      )
      expect(result.skills).toEqual([])
      expect(result.sources.map((source) => [source.sourceKind, source.skippedReason])).toEqual([
        ['home', 'unavailable'],
        ['repo', 'unavailable']
      ])
      const all = await unavailableWhileWslDistroStopped(() => Promise.reject(refusal))
      expect(all.sources.map((source) => source.sourceKind)).toEqual([
        'home',
        'repo',
        'bundled',
        'plugin'
      ])
    }
  )

  it('passes results through and rethrows any other failure', async () => {
    const result = { skills: [], sources: [], scannedAt: 1 }
    await expect(unavailableWhileWslDistroStopped(async () => result)).resolves.toBe(result)
    await expect(
      unavailableWhileWslDistroStopped(() => Promise.reject(new Error('repair required')))
    ).rejects.toThrow('repair required')
  })
})
