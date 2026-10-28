import { describe, expect, it } from 'vitest'
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../wsl/wsl-unc-access-gate'
import { unavailableWhileWslDistroStopped } from './skill-discovery-stopped-wsl-roots'

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
