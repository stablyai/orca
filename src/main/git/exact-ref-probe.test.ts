import { describe, expect, it, vi } from 'vitest'
import { probeAnyExactRef, probeExactRefs, probeExactRefsViaForEachRef } from './exact-ref-probe'

describe('probeExactRefs', () => {
  it('preserves present, absent, and unknown states while deduplicating refs', async () => {
    const present = 'refs/remotes/origin/main'
    const absent = 'refs/remotes/upstream/main'
    const unknown = 'refs/remotes/fork/main'
    const invalid = 'refs/remotes/origin/bad*'
    const runGit = vi.fn(async (argv: string[]) => {
      if (argv.at(-1) === absent) {
        throw Object.assign(new Error('no match'), { code: 1 })
      }
      if (argv.at(-1) === unknown) {
        throw Object.assign(new Error('transport failed'), { code: 128 })
      }
      return { stdout: '' }
    })

    await expect(
      probeExactRefs(runGit, [present, absent, unknown, invalid, '', present])
    ).resolves.toEqual({
      presentRefs: [present],
      absentRefs: [absent],
      unknownRefs: [unknown, invalid, '']
    })
    expect(runGit).toHaveBeenCalledTimes(3)
    expect(
      runGit.mock.calls.every(
        ([argv]) => argv.slice(0, 4).join(' ') === 'show-ref --verify --quiet --'
      )
    ).toBe(true)
  })

  it('bounds concurrent exact lookups', async () => {
    const refs = Array.from({ length: 20 }, (_, index) => `refs/remotes/remote-${index}/main`)
    let active = 0
    let maxActive = 0
    const runGit = vi.fn(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 0))
      active -= 1
      throw Object.assign(new Error('no match'), { code: 1 })
    })

    await probeExactRefs(runGit, refs)

    expect(runGit).toHaveBeenCalledTimes(20)
    // Require saturation so a regression to serial probing fails.
    expect(maxActive).toBe(8)
  })
})

describe('probeAnyExactRef', () => {
  it('stops scheduling once a ref is present', async () => {
    const refs = Array.from({ length: 20 }, (_, index) => `refs/remotes/remote-${index}/main`)
    const runGit = vi.fn(async (argv: string[]) => {
      if (argv.at(-1) === refs[0]) {
        return { stdout: '' }
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      throw Object.assign(new Error('no match'), { code: 1 })
    })

    await expect(probeAnyExactRef(runGit, refs)).resolves.toEqual({
      found: true,
      unknown: false
    })
    expect(runGit.mock.calls.length).toBeLessThanOrEqual(8)
  })
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

  it('still reads a quiet exit 1 as an absent ref', async () => {
    const runGit = vi.fn(async () => {
      throw Object.assign(new Error('missing'), { code: 1, stderr: '' })
    })

    const result = await probeExactRefs(runGit, ['refs/remotes/origin/main'])

    expect(result.absentRefs).toEqual(['refs/remotes/origin/main'])
    expect(result.unknownRefs).toEqual([])
  })
})

describe('probeExactRefsViaForEachRef', () => {
  const present = 'refs/remotes/origin/main'
  const descendantOnly = 'refs/remotes/fork/main'
  const invalid = 'refs/remotes/origin/bad*'

  it('answers all candidates from one child and ignores descendant matches', async () => {
    const runGit = vi.fn(async () => ({
      stdout: `${present}\r\n${descendantOnly}/sub\n`
    }))

    await expect(
      probeExactRefsViaForEachRef(runGit, [present, descendantOnly, invalid, present])
    ).resolves.toEqual({
      presentRefs: [present],
      absentRefs: [descendantOnly],
      unknownRefs: [invalid]
    })
    expect(runGit).toHaveBeenCalledTimes(1)
    expect(runGit).toHaveBeenCalledWith([
      'for-each-ref',
      '--format=%(refname)',
      '--',
      present,
      descendantOnly
    ])
  })

  it('falls back to per-ref probes when the batch fails', async () => {
    const runGit = vi.fn(async (argv: string[]) => {
      if (argv[0] === 'for-each-ref' || argv.at(-1) === descendantOnly) {
        throw Object.assign(new Error('failed'), { code: 1 })
      }
      return { stdout: '' }
    })

    await expect(probeExactRefsViaForEachRef(runGit, [present, descendantOnly])).resolves.toEqual({
      presentRefs: [present],
      absentRefs: [descendantOnly],
      unknownRefs: []
    })
    expect(runGit).toHaveBeenCalledTimes(3)
  })
})
