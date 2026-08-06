// SCRATCH (regb-): adversarial review of orderCodexRolloutCandidatesForParse.
import { describe, expect, it } from 'vitest'
import {
  codexRolloutHardlinkIdentity,
  dedupeCodexRolloutFileAliases,
  orderCodexRolloutCandidatesForParse,
  promoteCanonicalCodexRolloutAliases
} from './codex-session-root-dedup'

type Candidate = {
  id: number
  agent: string
  path: string
  codexHome: string | null
  dev?: number
  ino?: number
  nlink?: number
}

const accessors = {
  isCodex: (c: Candidate) => c.agent === 'codex',
  getFilePath: (c: Candidate) => c.path,
  getCodexHome: (c: Candidate) => c.codexHome,
  getHardlinkIdentity: (c: Candidate) => codexRolloutHardlinkIdentity(c)
}

// Deterministic PRNG so a failure is reproducible from the seed alone.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const ROOTS: { home: string | null; prefix: string }[] = [
  { home: null, prefix: '/home/u/.codex/sessions' },
  {
    home: '/opt/orca/codex-runtime-home/home',
    prefix: '/opt/orca/codex-runtime-home/home/sessions'
  },
  {
    home: '/opt/orca/codex-accounts/acct-1/home',
    prefix: '/opt/orca/codex-accounts/acct-1/home/sessions'
  },
  { home: '/home/u/import-a', prefix: '/home/u/import-a/sessions' },
  { home: '/home/u/import-b', prefix: '/home/u/import-b/sessions' },
  {
    home: '\\\\wsl$\\Ubuntu\\home\\u\\.codex',
    prefix: '\\\\wsl$\\Ubuntu\\home\\u\\.codex\\sessions'
  },
  {
    home: '\\\\wsl$\\Debian\\home\\u\\.codex',
    prefix: '\\\\wsl$\\Debian\\home\\u\\.codex\\sessions'
  }
]

const FILE_NAMES = [
  'rollout-2026-07-01T10-00-00-aaaa.jsonl',
  'rollout-2026-07-02T10-00-00-bbbb.jsonl',
  'rollout-2026-07-03T10-00-00-cccc.jsonl',
  // Not a rollout name: must never be grouped or moved.
  'notes.jsonl',
  'session-2026-07-04.jsonl',
  'rollout-weird.txt'
]

function randomCandidates(seed: number, count: number): Candidate[] {
  const random = makeRandom(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  return Array.from({ length: count }, (_unused, id) => {
    const root = pick(ROOTS)
    const separator = root.prefix.includes('\\') ? '\\' : '/'
    const agent = random() < 0.25 ? pick(['claude', 'gemini', 'cursor']) : 'codex'
    const hardlinked = random() < 0.3
    return {
      id,
      agent,
      path: `${root.prefix}${separator}${pick(FILE_NAMES)}`,
      codexHome: root.home,
      dev: hardlinked ? 1 : 2,
      ino: hardlinked ? Math.floor(random() * 5) + 1 : id + 1000,
      nlink: hardlinked ? 2 : 1
    }
  })
}

function multiset(candidates: readonly Candidate[]): string {
  return JSON.stringify([...candidates].map((c) => c.id).sort((a, b) => a - b))
}

describe('regb fix review: promotion is order-only', () => {
  it('ITEM 1: same multiset in, same multiset out (500 random inputs)', () => {
    let checked = 0
    for (let seed = 1; seed <= 500; seed += 1) {
      const input = randomCandidates(seed, 60)
      const output = promoteCanonicalCodexRolloutAliases(input, accessors)
      expect(output).toHaveLength(input.length)
      expect(multiset(output)).toBe(multiset(input))
      checked += 1
    }
    console.log('ITEM1 seeds checked', checked, '-> multiset always preserved')
  })

  it('ITEM 1b: non-codex and non-rollout candidates never move', () => {
    let moved = 0
    let immovable = 0
    for (let seed = 1; seed <= 500; seed += 1) {
      const input = randomCandidates(seed, 60)
      const output = promoteCanonicalCodexRolloutAliases(input, accessors)
      input.forEach((candidate, index) => {
        const isRollout = /^rollout-.+\.jsonl$/.test(candidate.path.split(/[\\/]/).at(-1)!)
        if (candidate.agent !== 'codex' || !isRollout) {
          immovable += 1
          if (output[index]!.id !== candidate.id) {
            moved += 1
          }
        }
      })
    }
    console.log('ITEM1b immovable candidates', immovable, 'that moved:', moved)
    expect(moved).toBe(0)
  })

  it('ITEM 2: a group only ever permutes its own slots', () => {
    let outsideChanges = 0
    for (let seed = 1; seed <= 500; seed += 1) {
      const input = randomCandidates(seed, 60)
      const output = promoteCanonicalCodexRolloutAliases(input, accessors)
      // Slots that changed must all belong to one alias group key.
      const changedKeys = new Set<string>()
      input.forEach((candidate, index) => {
        if (output[index]!.id === candidate.id) {
          return
        }
        const before = groupKey(candidate)
        const after = groupKey(output[index]!)
        if (before === null || before !== after) {
          outsideChanges += 1
        }
        changedKeys.add(String(before))
      })
    }
    console.log('ITEM2 slots that changed to a DIFFERENT alias group:', outsideChanges)
    expect(outsideChanges).toBe(0)
  })

  it('ITEM 2b: relative mtime order of unrelated rollouts is untouched', () => {
    // Input is already mtime-desc (index order). For any two candidates in
    // DIFFERENT groups, their relative order must be unchanged.
    let inversions = 0
    for (let seed = 1; seed <= 200; seed += 1) {
      const input = randomCandidates(seed, 40)
      const output = promoteCanonicalCodexRolloutAliases(input, accessors)
      const positionOfGroupSlots = new Map<string, number[]>()
      output.forEach((candidate, index) => {
        const key = groupKey(candidate)
        if (key === null) {
          return
        }
        const slots = positionOfGroupSlots.get(key)
        if (slots) {
          slots.push(index)
        } else {
          positionOfGroupSlots.set(key, [index])
        }
      })
      // Every group occupies exactly the slot set it occupied on input.
      for (const [key, slots] of positionOfGroupSlots) {
        const inputSlots: number[] = []
        input.forEach((candidate, index) => {
          if (groupKey(candidate) === key) {
            inputSlots.push(index)
          }
        })
        if (JSON.stringify(slots) !== JSON.stringify(inputSlots)) {
          inversions += 1
        }
      }
    }
    console.log('ITEM2b groups whose SLOT SET changed:', inversions)
    expect(inversions).toBe(0)
  })

  it('ITEM 5: promotion never moves a row across the WSL/native boundary', () => {
    let crossings = 0
    for (let seed = 1; seed <= 500; seed += 1) {
      const input = randomCandidates(seed, 60)
      const output = promoteCanonicalCodexRolloutAliases(input, accessors)
      input.forEach((candidate, index) => {
        if (namespaceOf(candidate.path) !== namespaceOf(output[index]!.path)) {
          crossings += 1
        }
      })
    }
    console.log('ITEM5 namespace crossings:', crossings)
    expect(crossings).toBe(0)
  })

  it('ITEM 4: promotion never resurrects a candidate the alias pass dropped', () => {
    let resurrected = 0
    let orderingConflicts = 0
    for (let seed = 1; seed <= 500; seed += 1) {
      const input = randomCandidates(seed, 60)
      const deduped = dedupeCodexRolloutFileAliases(input, accessors)
      const ordered = orderCodexRolloutCandidatesForParse(input, accessors)
      expect(ordered).toHaveLength(deduped.length)
      const survivorIds = new Set(deduped.map((c) => c.id))
      for (const candidate of ordered) {
        if (!survivorIds.has(candidate.id)) {
          resurrected += 1
        }
      }
      // Both passes rank by codexSessionRootRank; the survivor of a hardlink
      // group must never be out-ranked by a promoted sibling in the same group.
      const byKey = new Map<string, number>()
      ordered.forEach((candidate, index) => {
        const key = groupKey(candidate)
        if (key === null) {
          return
        }
        const rank = rankOf(candidate.codexHome)
        const bestSoFar = byKey.get(key)
        if (bestSoFar !== undefined && rank < bestSoFar) {
          orderingConflicts += 1
        }
        byKey.set(key, bestSoFar === undefined ? rank : Math.min(bestSoFar, rank))
        void index
      })
    }
    console.log('ITEM4 resurrected:', resurrected, 'rank-order conflicts:', orderingConflicts)
    expect(resurrected).toBe(0)
    expect(orderingConflicts).toBe(0)
  })

  it('ITEM 6: perf — 200k candidates incl. one 5k-member group', () => {
    const candidates: Candidate[] = []
    for (let i = 0; i < 5_000; i += 1) {
      candidates.push({
        id: i,
        agent: 'codex',
        path: `/root-${i}/sessions/rollout-2026-07-01T10-00-00-shared.jsonl`,
        codexHome: `/root-${i}`,
        dev: 2,
        ino: i + 1,
        nlink: 1
      })
    }
    for (let i = 0; i < 195_000; i += 1) {
      candidates.push({
        id: 5_000 + i,
        agent: 'codex',
        path: `/home/u/.codex/sessions/rollout-2026-07-01T10-00-00-u${i}.jsonl`,
        codexHome: null,
        dev: 2,
        ino: 1_000_000 + i,
        nlink: 1
      })
    }
    const started = performance.now()
    const output = orderCodexRolloutCandidatesForParse(candidates, accessors)
    const elapsedMs = performance.now() - started
    console.log('ITEM6 n=', candidates.length, 'elapsedMs=', Math.round(elapsedMs))
    expect(output).toHaveLength(candidates.length)
    expect(elapsedMs).toBeLessThan(5_000)
  })
})

function namespaceOf(path: string): string {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(path)
    ? `wsl:${path.split(/[\\/]/).filter(Boolean)[1]?.toLowerCase()}`
    : 'native'
}

function groupKey(candidate: Candidate): string | null {
  if (candidate.agent !== 'codex') {
    return null
  }
  const fileName = candidate.path.split(/[\\/]/).at(-1)!
  if (!/^rollout-.+\.jsonl$/.test(fileName)) {
    return null
  }
  return `${namespaceOf(candidate.path)}\0${fileName}`
}

function rankOf(codexHome: string | null): number {
  if (codexHome === null) {
    return 0
  }
  const segments = codexHome.split(/[\\/]/).filter(Boolean)
  const shared = segments.at(-2) === 'codex-runtime-home' && segments.at(-1) === 'home'
  const perAccount = segments.at(-3) === 'codex-accounts' && segments.at(-1) === 'home'
  return shared || perAccount ? 1 : 2
}
