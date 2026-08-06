// Codex rollout candidates reach the parse budget in mtime order, and the budget
// cuts the tail. Ordering therefore decides which root's copy of a rollout is
// ever parsed, and so which one post-parse dedup gets to choose between. These
// pin what the ordering pass may and may not do to that list.
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

describe('Codex rollout parse ordering', () => {
  it('adds and drops nothing, across 500 seeded inputs', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const input = randomCandidates(seed, 60)
      const output = promoteCanonicalCodexRolloutAliases(input, accessors)
      expect(output).toHaveLength(input.length)
      expect(multiset(output)).toBe(multiset(input))
    }
  })

  it('never moves a non-Codex or non-rollout candidate', () => {
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
    expect(moved).toBe(0)
  })

  it('permutes only the slots an alias group already occupied', () => {
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
    expect(outsideChanges).toBe(0)
  })

  it('preserves the relative mtime order of unrelated rollouts', () => {
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
    expect(inversions).toBe(0)
  })

  it('never moves a row across the WSL/native execution boundary', () => {
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
    expect(crossings).toBe(0)
  })

  it('never resurrects a candidate the hardlink alias pass dropped', () => {
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
    expect(resurrected).toBe(0)
    expect(orderingConflicts).toBe(0)
  })

  // The case for every user who has not set a Codex session source home: with a
  // single root there are no alias groups, so the pass must return the list
  // untouched rather than perturb a shared scanner path for everyone.
  it('is inert when a single Codex root is scanned', () => {
    const input: Candidate[] = Array.from({ length: 25 }, (_unused, id) => ({
      id,
      agent: 'codex',
      path: `/home/u/.codex/sessions/rollout-2026-07-01T10-00-00-${String(id).padStart(4, '0')}.jsonl`,
      codexHome: null,
      dev: 2,
      ino: id + 1,
      nlink: 1
    }))

    expect(orderCodexRolloutCandidatesForParse(input, accessors)).toEqual(input)
  })

  it('stays linear on a pathological single-name group', () => {
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
    for (let i = 0; i < 45_000; i += 1) {
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
