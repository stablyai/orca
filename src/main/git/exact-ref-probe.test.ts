import { describe, expect, it, vi } from 'vitest'
import { isShowRefNoMatchError, probeAnyExactRef, probeExactRefs } from './exact-ref-probe'

describe('isShowRefNoMatchError', () => {
  it('accepts only the numeric Git no-match exit status', () => {
    expect(isShowRefNoMatchError({ code: 1 })).toBe(true)
    expect(isShowRefNoMatchError({ code: '1' })).toBe(false)
    expect(isShowRefNoMatchError({ code: 'CONNECTION_LOST' })).toBe(false)
    expect(isShowRefNoMatchError({ code: -32000 })).toBe(false)
  })
})

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

  it('forwards max-buffer and timeout options', async () => {
    const runGit = vi.fn(async () => ({ stdout: '' }))
    const ref = 'refs/remotes/origin/main'

    await probeExactRefs(runGit, [ref], { maxBuffer: 4096, timeoutMs: 30_000 })

    expect(runGit).toHaveBeenCalledWith(['show-ref', '--verify', '--quiet', '--', ref], {
      maxBuffer: 4096,
      timeoutMs: 30_000
    })
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
    // Equality, not a ceiling: 20 refs saturate the pool, so a regression to
    // serial probing has to fail here.
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
    // Why: `wsl.exe` exits 1 for its own launch failures. Reading that as
    // absence would collapse `unverifiable` into `exited`.
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

  it('keeps the exit-code contract for a runner that reports no stderr', async () => {
    // The SSH provider rejects without a stderr field; absence must still resolve.
    const runGit = vi.fn(async () => {
      throw Object.assign(new Error('missing'), { code: 1 })
    })

    const result = await probeExactRefs(runGit, ['refs/remotes/origin/main'])

    expect(result.absentRefs).toEqual(['refs/remotes/origin/main'])
  })
})
