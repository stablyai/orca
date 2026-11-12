import { describe, expect, it, vi } from 'vitest'
import { probeExactRefs } from './exact-ref-probe'

describe('probeAnyExactRef', () => {
  it('treats exit 1 with stderr as an inconclusive probe, not an absent ref', async () => {
    // WSL launch failure is unknown ref state, never proof of absence.
    const runGit = vi.fn(async () => {
      throw Object.assign(new Error('wsl fail'), {
        code: 1,
        stderr: 'There is no distribution with the supplied name.'
      })
    })

    const result = await probeExactRefs(runGit, ['refs/remotes/origin/main'])

    expect(result.unknownRefs).toEqual(['refs/remotes/origin/main'])
    expect(result.absentRefs).toEqual([])
  })
})
