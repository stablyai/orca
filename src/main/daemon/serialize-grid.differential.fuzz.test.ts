import { appendFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildSerializeFuzzCase,
  type SerializeFuzzCase,
  type SerializeFuzzCategory
} from './serialize-grid-fuzz-stream'
import {
  i1Applies,
  i1BytesDifferByVariant,
  loadOldSerializer,
  NEW_SERIALIZER,
  runSerializeFuzzCase,
  verdicts,
  type NamedSerializer,
  type SerializeCheckResult,
  type Verdict
} from './serialize-grid-roundtrip'

// Serialize→replay round-trip fuzz for the addon-serialize patch. Invariants:
//   I1 no line in the serialized range is wider than the grid, and no blank background-colored
//      row follows its last text row (the old build trimmed those) ⇒ new bytes === old bytes
//   I2 replaying the new bytes reproduces the source grid, cursor, buffer and modes
//   I3 every checkpoint the old build replayed faithfully, the new one does too
// I1/I3 need a baseline build: ORCA_OLD_SERIALIZE_ADDON=$(node
// config/scripts/build-serialize-addon-at-ref.mjs --ref origin/main --out-dir <dir>).
// ORCA_NEW_SERIALIZE_ADDON likewise replaces the installed build under test.
//
//   SERIALIZE_FUZZ_ITERATIONS=7000  cases per category (default 40)
//   SERIALIZE_FUZZ_SEED=1234        re-run exactly one seed (all categories)
//   SERIALIZE_FUZZ_CATEGORY=alt       run one of normal | alt | conpty
//   SERIALIZE_FUZZ_REPORT=1         print tallies and minimized failures

const ALL_CATEGORIES: readonly SerializeFuzzCategory[] = ['normal', 'alt', 'conpty']
const CATEGORIES = ALL_CATEGORIES.filter(
  (category) =>
    !process.env.SERIALIZE_FUZZ_CATEGORY || process.env.SERIALIZE_FUZZ_CATEGORY === category
)
const FIXED_SEED = readPositiveIntEnv('SERIALIZE_FUZZ_SEED')
const ITERATIONS = FIXED_SEED !== null ? 1 : (readPositiveIntEnv('SERIALIZE_FUZZ_ITERATIONS') ?? 40)
const OLD_ADDON_PATH = process.env.ORCA_OLD_SERIALIZE_ADDON
const REPORT = process.env.SERIALIZE_FUZZ_REPORT === '1'

function readPositiveIntEnv(name: string): number | null {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null
}

async function caseVerdicts(
  testCase: SerializeFuzzCase,
  serializers: readonly NamedSerializer[]
): Promise<Set<Verdict>> {
  const { checks } = await runSerializeFuzzCase(testCase, serializers)
  return new Set(checks.flatMap((check) => verdicts(check, serializers.length > 1)))
}

/** Greedy step-drop minimizer that keeps the given verdict reproducing. */
async function minimize(
  testCase: SerializeFuzzCase,
  verdict: Verdict,
  serializers: readonly NamedSerializer[]
): Promise<SerializeFuzzCase> {
  let current = testCase
  let shrunk = true
  while (shrunk) {
    shrunk = false
    for (let i = current.steps.length - 2; i >= 0; i--) {
      const candidate = { ...current, steps: current.steps.toSpliced(i, 1) }
      if ((await caseVerdicts(candidate, serializers)).has(verdict)) {
        current = candidate
        shrunk = true
      }
    }
  }
  return current
}

type Tally = {
  cases: number
  xtermCrash: number
  checks: number
  overlongChecks: number
  clippedWideChecks: number
  i1Applicable: number
  i1Fail: number
  newI2Fail: number
  oldI2Fail: number
  regression: number
  fixed: number
  bothFail: number
  wrapDiffNew: number
  wrapRegression: number
  stages: Record<string, number>
}

function emptyTally(): Tally {
  return {
    cases: 0,
    xtermCrash: 0,
    checks: 0,
    overlongChecks: 0,
    clippedWideChecks: 0,
    i1Applicable: 0,
    i1Fail: 0,
    newI2Fail: 0,
    oldI2Fail: 0,
    regression: 0,
    fixed: 0,
    bothFail: 0,
    wrapDiffNew: 0,
    wrapRegression: 0,
    stages: {}
  }
}

function addToTally(tally: Tally, check: SerializeCheckResult, differential: boolean): void {
  tally.checks++
  tally.overlongChecks += check.overlong[0] ? 1 : 0
  tally.clippedWideChecks += check.clippedWideCells > 0 ? 1 : 0
  tally.newI2Fail += check.gridDiff.new ? 1 : 0
  tally.wrapDiffNew += check.wrapDiff.new ? 1 : 0
  for (const [name, diff] of Object.entries(check.gridDiff)) {
    if (diff) {
      const key = `${name}:${diff.stage}`
      tally.stages[key] = (tally.stages[key] ?? 0) + 1
    }
  }
  if (!differential) {
    return
  }
  tally.oldI2Fail += check.gridDiff.old ? 1 : 0
  const oldFaithful = !check.gridDiff.old && !check.wrapDiff.old
  tally.wrapRegression += oldFaithful && check.wrapDiff.new ? 1 : 0
  const differs = i1BytesDifferByVariant(check)
  i1Applies(check).forEach((applies, v) => {
    if (applies) {
      tally.i1Applicable++
      tally.i1Fail += differs[v] ? 1 : 0
    }
  })
  const v = verdicts(check, true)
  tally.regression += v.includes('regression') ? 1 : 0
  tally.fixed += v.includes('fixed') ? 1 : 0
  tally.bothFail += v.includes('both-fail') ? 1 : 0
}

type Failure = { seed: number; category: SerializeFuzzCategory; verdict: Verdict }

const DUMP_PATH = process.env.SERIALIZE_FUZZ_DUMP

async function runSweep(serializers: readonly NamedSerializer[]): Promise<{
  tallies: Record<SerializeFuzzCategory, Tally>
  failures: Failure[]
}> {
  const differential = serializers.length > 1
  const tallies = { normal: emptyTally(), alt: emptyTally(), conpty: emptyTally() }
  const failures: Failure[] = []
  for (const category of CATEGORIES) {
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = FIXED_SEED ?? 1 + i
      const run = await runSerializeFuzzCase(buildSerializeFuzzCase(seed, category), serializers)
      const checks = run.checks
      tallies[category].cases++
      tallies[category].xtermCrash += run.sourceCrash ? 1 : 0
      const seen = new Set<Verdict>()
      for (const check of checks) {
        if (DUMP_PATH) {
          appendFileSync(
            DUMP_PATH,
            `${JSON.stringify({ seed, category, stepIndex: check.stepIndex, overlong: check.overlong, clipped: check.clippedWideCells, verdicts: verdicts(check, differential), grid: check.gridDiff, wrap: check.wrapDiff })}\n`
          )
        }
        addToTally(tallies[category], check, differential)
        for (const verdict of verdicts(check, differential)) {
          if (verdict !== 'fixed' && !seen.has(verdict)) {
            seen.add(verdict)
            failures.push({ seed, category, verdict })
          }
        }
      }
    }
  }
  return { tallies, failures }
}

async function describeFailures(
  failures: Failure[],
  serializers: readonly NamedSerializer[]
): Promise<string> {
  const lines: string[] = []
  for (const failure of failures.slice(0, 12)) {
    const minimized = await minimize(
      buildSerializeFuzzCase(failure.seed, failure.category),
      failure.verdict,
      serializers
    )
    const { checks } = await runSerializeFuzzCase(minimized, serializers)
    const failing = checks.find((c) =>
      verdicts(c, serializers.length > 1).includes(failure.verdict)
    )
    lines.push(
      `${failure.verdict} seed=${failure.seed} category=${failure.category} (SERIALIZE_FUZZ_SEED=${failure.seed})`,
      `  start ${minimized.cols}x${minimized.rows} scrollback=${minimized.sourceScrollback} steps=${JSON.stringify(minimized.steps)}`,
      `  new: ${JSON.stringify(failing?.gridDiff.new)}`,
      `  old: ${JSON.stringify(failing?.gridDiff.old)}`
    )
  }
  return lines.join('\n')
}

// Seeds 1-25 whose NEW replay already diverges and whose OLD replay diverges
// the same way (verified with ORCA_OLD_SERIALIZE_ADDON): upstream limitations
// such as orphan combining marks in column 0 and wide glyphs reflowed into the
// last column. Shrink this list when one is fixed.
const CI_SEEDS = 25
const KNOWN_PREEXISTING_I2_FAILURES: Record<SerializeFuzzCategory, number[]> = {
  normal: [4, 5, 8, 9, 14, 19, 25],
  alt: [1, 2, 3, 4, 6, 7, 8, 11, 12, 14, 17, 19, 20, 21, 22, 23],
  conpty: [4, 8, 9, 11, 19]
}

// I3 regressions found at 7000 seeds per mode against origin/main (#22586), kept as guards
// now that both are fixed: 1149 = clipped-wide blank had width 0; the rest = trailing
// background-only rows were trimmed.
const FOUND_I3_REGRESSIONS: Record<SerializeFuzzCategory, number[]> = {
  normal: [4681],
  alt: [1674],
  conpty: [130, 1149, 2590, 3827, 4012, 4841, 6461]
}

describe('serialize grid round-trip fuzz', () => {
  it.skipIf(!OLD_ADDON_PATH)('previously found I3 regression seeds do not regress', async () => {
    const serializers = [loadOldSerializer(OLD_ADDON_PATH!), NEW_SERIALIZER]
    const regressed: string[] = []
    for (const category of ALL_CATEGORIES) {
      for (const seed of FOUND_I3_REGRESSIONS[category]) {
        if (
          (await caseVerdicts(buildSerializeFuzzCase(seed, category), serializers)).has(
            'regression'
          )
        ) {
          regressed.push(`${category}:${seed}`)
        }
      }
    }
    expect(regressed).toEqual([])
  })

  // The pin describes the installed build; an ORCA_NEW_SERIALIZE_ADDON override is judged by I3 instead.
  it.skipIf(Boolean(process.env.ORCA_NEW_SERIALIZE_ADDON))(
    'I2 on a fixed seed range: only the pinned pre-existing divergences remain',
    async () => {
      const failing: Record<SerializeFuzzCategory, number[]> = { normal: [], alt: [], conpty: [] }
      for (const category of ALL_CATEGORIES) {
        for (let seed = 1; seed <= CI_SEEDS; seed++) {
          const run = await runSerializeFuzzCase(buildSerializeFuzzCase(seed, category), [
            NEW_SERIALIZER
          ])
          if (run.checks.some((check) => check.gridDiff.new !== null)) {
            failing[category].push(seed)
          }
        }
      }
      expect(failing).toEqual(KNOWN_PREEXISTING_I2_FAILURES)
    },
    120_000
  )

  it.skipIf(!OLD_ADDON_PATH)(
    'I1/I3 against the previous serialize build: identical bytes when nothing is wider than the grid, and no checkpoint gets worse',
    async () => {
      const serializers = [loadOldSerializer(OLD_ADDON_PATH!), NEW_SERIALIZER]
      const { tallies, failures } = await runSweep(serializers)
      const blocking = failures.filter(
        (f) => f.verdict === 'i1-bytes-differ' || f.verdict === 'regression'
      )
      if (REPORT) {
        console.log(JSON.stringify(tallies, null, 1))
        const preexisting = failures.filter((f) => f.verdict === 'both-fail')
        console.log(`blocking:\n${await describeFailures(blocking, serializers)}`)
        console.log(
          `pre-existing (${preexisting.length}):\n${await describeFailures(preexisting, serializers)}`
        )
      }
      expect(blocking.length ? await describeFailures(blocking, serializers) : '').toBe('')
    },
    3_600_000
  )
})
