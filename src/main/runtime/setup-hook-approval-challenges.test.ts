import { describe, expect, it } from 'vitest'
import { SetupHookApprovalChallenges } from './setup-hook-approval-challenges'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)

describe('SetupHookApprovalChallenges', () => {
  it('consumes an exact owner-bound challenge once', () => {
    const challenges = new SetupHookApprovalChallenges()
    const token = challenges.issue({ repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_A })
    const approval = { kind: 'setup' as const, token, contentHash: HASH_A }

    expect(
      challenges.consume(approval, {
        repoId: 'repo-a',
        deviceId: 'device-a',
        contentHash: HASH_A
      })
    ).toBe(true)
    expect(
      challenges.consume(approval, {
        repoId: 'repo-a',
        deviceId: 'device-a',
        contentHash: HASH_A
      })
    ).toBe(false)
  })

  it.each([
    ['repo', { repoId: 'repo-b', deviceId: 'device-a', contentHash: HASH_A }],
    ['device', { repoId: 'repo-a', deviceId: 'device-b', contentHash: HASH_A }],
    ['content', { repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_B }]
  ])('rejects %s replay', (_label, expected) => {
    const challenges = new SetupHookApprovalChallenges()
    const token = challenges.issue({ repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_A })

    expect(challenges.consume({ kind: 'setup', token, contentHash: HASH_A }, expected)).toBe(false)
  })

  it('rejects stale challenges', () => {
    let now = 1
    const challenges = new SetupHookApprovalChallenges(10, 10, () => now)
    const token = challenges.issue({ repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_A })
    now = 12

    expect(
      challenges.consume(
        { kind: 'setup', token, contentHash: HASH_A },
        { repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_A }
      )
    ).toBe(false)
  })

  it('rejects an approval whose claimed hash disagrees with the issued challenge', () => {
    const challenges = new SetupHookApprovalChallenges()
    const token = challenges.issue({ repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_A })

    // Client claims it approved the content the host is about to run (B) with a token minted for A.
    expect(
      challenges.consume(
        { kind: 'setup', token, contentHash: HASH_B },
        { repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_B }
      )
    ).toBe(false)
  })

  it('fails closed when capacity eviction drops a pending challenge', () => {
    const challenges = new SetupHookApprovalChallenges(10_000, 2)
    const evicted = challenges.issue({
      repoId: 'repo-a',
      deviceId: 'device-a',
      contentHash: HASH_A
    })
    challenges.issue({ repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_B })
    const kept = challenges.issue({ repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_C })

    expect(
      challenges.consume(
        { kind: 'setup', token: evicted, contentHash: HASH_A },
        { repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_A }
      )
    ).toBe(false)
    expect(
      challenges.consume(
        { kind: 'setup', token: kept, contentHash: HASH_C },
        { repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_C }
      )
    ).toBe(true)
  })

  it('reuses one challenge for repeated reads of the same repo, device and content', () => {
    let now = 1
    const challenges = new SetupHookApprovalChallenges(10, 2, () => now)
    const args = { repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_A }

    const first = challenges.issue(args)
    now = 6
    // A later read extends the window the host already vouched for instead of minting again.
    expect(challenges.issue(args)).toBe(first)
    now = 12

    expect(challenges.consume({ kind: 'setup', token: first, contentHash: HASH_A }, args)).toBe(
      true
    )
  })

  it('does not let one device evict another device pending approval', () => {
    const challenges = new SetupHookApprovalChallenges(10_000, 2)
    const honest = challenges.issue({ repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_A })
    // device-b crowds the map; only its own oldest entry may be dropped.
    challenges.issue({ repoId: 'repo-a', deviceId: 'device-b', contentHash: HASH_B })
    challenges.issue({ repoId: 'repo-a', deviceId: 'device-b', contentHash: HASH_C })

    expect(
      challenges.consume(
        { kind: 'setup', token: honest, contentHash: HASH_A },
        { repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_A }
      )
    ).toBe(true)
  })

  it('rejects missing proof and tokens from another runtime generation', () => {
    const oldRuntime = new SetupHookApprovalChallenges()
    const newRuntime = new SetupHookApprovalChallenges()
    const token = oldRuntime.issue({
      repoId: 'repo-a',
      deviceId: 'device-a',
      contentHash: HASH_A
    })
    const expected = { repoId: 'repo-a', deviceId: 'device-a', contentHash: HASH_A }

    expect(newRuntime.consume(undefined, expected)).toBe(false)
    expect(newRuntime.consume({ kind: 'setup', token, contentHash: HASH_A }, expected)).toBe(false)
  })
})
