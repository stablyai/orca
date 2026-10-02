// Decides whether a set of red branches is red because `main` was already broken
// (upstream) or because the branches themselves broke something.
//
// Why this exists: `main` carries no checks of its own. `pr.yml` — the workflow
// that holds the tests, typecheck and static analysis — is `on: pull_request`
// only, and `unit-tests.yml` is `workflow_call` only, so no commit on `main` has
// a test result attached to it. Asking "was main green at SHA X?" directly
// returns nothing, which is why nobody reaches for it. The answer has to be
// reconstructed from the PRs whose CI ran against `main` at that moment.
//
// See docs/reference/upstream-breakage-diagnosis.md.

// Verdicts. `unknown` is the default: a probe that cannot see enough evidence
// must never report `clean`, because "no evidence of breakage" and "evidence of
// no breakage" are the two states this tool exists to keep apart.
export const VERDICT = {
  broken: 'broken',
  clean: 'clean',
  unknown: 'unknown',
  upstream: 'upstream',
  sharedAncestor: 'shared-ancestor',
  divergent: 'divergent',
  noFailures: 'no-failures'
}

// Roll-up jobs reprint another job's failure; counting one as an independent
// failure double-counts the same breakage and makes divergent sets look identical.
export const ROLLUP_CHECKS = new Set(['verify'])

// Reds that are red for reasons unrelated to the commit under test. Counting
// these as breakage makes every window look broken.
export const KNOWN_FALSE_REDS = new Set([
  'test / tests node 24 1/8',
  'test / tests node 24 6/8',
  'e2e / ssh docker watcher isolation'
])

// Third-party review bots post checks on the same commit. They are not signal
// about the tree, so only first-party Actions checks count by default.
export const DEFAULT_APP_SLUGS = new Set(['github-actions'])

// Lanes that actually execute the tree, so a green one is evidence `main` built,
// type-checked or ran. Everything else on a PR — the path classifier, the
// root-directory guard, the LoC counter, the community-PR labeller — stays green
// on a `main` that is entirely broken, so a witness carrying only those witnessed
// nothing.
//
// An allowlist, and deliberately so: an unrecognised name here costs a witness
// and the verdict degrades to `unknown`, whereas an unrecognised name in a
// denylist would count as a full witness and hand back `clean` — the failure this
// list exists to close. `normalizeChecks` reports every name it did not
// recognise so a renamed lane is loud rather than silently dropped.
export const WITNESSING_CHECK_PATTERNS = [
  // pr.yml: the lanes that build, type-check, lint or run the suite.
  /^typecheck$/,
  /^static analysis$/,
  /^test$/,
  /^test \/ tests\b/,
  /^prepare test native cache\b/,
  /^package$/,
  /^package \(/,
  /^managed hooks on Node \d+$/,
  /^shell contracts$/,
  /^Git compatibility$/,
  /^xterm patch sync$/,
  /^cross-version wire compatibility$/,
  /^orcad browser provider$/,
  // e2e.yml: the shards and the app build. `changed e2e specs` only reads the
  // diff, so it is not one of these.
  /^e2e$/,
  /^e2e \d+-of-\d+$/,
  /^e2e \/ (?!changed e2e specs$)/,
  /^build e2e app$/,
  /^prepare Electron native cache$/,
  /^ssh docker watcher isolation$/,
  // Platform smoke and IME lanes.
  /^real IME/,
  /^native-smoke \(/,
  /^mac-native-owner-smoke$/
]

// Would this check have gone red if `main` were broken?
export function isWitnessingCheck(name, patterns = WITNESSING_CHECK_PATTERNS) {
  return patterns.some((pattern) => pattern.test(name))
}

// Branches everything else forks from. Two PRs based on trunk are independent;
// two based on the same feature branch share that branch's diff.
export const TRUNK_REFS = new Set(['main', 'master'])

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required'])
const NON_RUN_CONCLUSIONS = new Set(['skipped', 'neutral'])

// Minimum independent witnesses before any positive verdict. One witness cannot
// separate "main is broken" from "this branch is broken".
export const MIN_WITNESSES = 2

// Two checks that ran days apart observed two different `main`s, so agreeing
// failures say nothing about either. Beyond this span the answer is `unknown`.
export const MAX_EVIDENCE_SPAN_HOURS = 24

// Splits a commit's check runs into the real failures and everything deliberately
// dropped. `excluded` is returned rather than discarded so callers can print it —
// a silently narrowed population reads as full coverage.
export function normalizeChecks(checkRuns, options = {}) {
  const includeKnownFalse = options.includeKnownFalse === true
  const appSlugs = options.appSlugs ?? DEFAULT_APP_SLUGS
  const witnessPatterns = options.witnessingCheckPatterns ?? WITNESSING_CHECK_PATTERNS
  const failures = []
  const ran = []
  const excluded = { rollup: [], knownFalse: [], foreignApp: [], nonWitnessing: [] }
  let incomplete = 0
  let completedAt = null

  for (const run of checkRuns) {
    const name = run.name
    const slug = run.app?.slug ?? run.appSlug ?? null
    if (slug !== null && !appSlugs.has(slug)) {
      if (FAILING_CONCLUSIONS.has(run.conclusion)) {
        excluded.foreignApp.push(name)
      }
      continue
    }
    if (ROLLUP_CHECKS.has(name)) {
      if (FAILING_CONCLUSIONS.has(run.conclusion)) {
        excluded.rollup.push(name)
      }
      continue
    }
    if (run.status !== 'completed') {
      incomplete += 1
      continue
    }
    if (NON_RUN_CONCLUSIONS.has(run.conclusion)) {
      continue
    }
    if (!includeKnownFalse && KNOWN_FALSE_REDS.has(name)) {
      if (FAILING_CONCLUSIONS.has(run.conclusion)) {
        excluded.knownFalse.push(name)
      }
      continue
    }
    ran.push(name)
    if (
      run.completedAt !== null &&
      run.completedAt !== undefined &&
      run.completedAt > (completedAt ?? '')
    ) {
      completedAt = run.completedAt
    }
    if (FAILING_CONCLUSIONS.has(run.conclusion)) {
      failures.push(name)
    }
  }

  // Dedupe: a re-run posts the same check name twice, and a repeated name would
  // make two identical failure sets compare as different multisets.
  const uniqueRan = [...new Set(ran)].sort()
  const witnessing = uniqueRan.filter((name) => isWitnessingCheck(name, witnessPatterns))
  excluded.nonWitnessing = uniqueRan.filter((name) => !isWitnessingCheck(name, witnessPatterns))
  return {
    failures: [...new Set(failures)].sort(),
    ran: uniqueRan,
    // The subset of `ran` that would have gone red had `main` been broken.
    witnessing,
    excluded,
    incomplete,
    completedAt,
    // Only a PR on which some lane actually executed the tree witnessed anything.
    // A path-filtered PR still posts its path classifier, root-directory guard and
    // LoC counter green; counting those as a witness is how `clean` gets returned
    // for a window nothing was tested in.
    usable: incomplete === 0 && witnessing.length > 0
  }
}

// Groups PRs into stacks by branch parentage: a PR whose base branch is another
// PR's head branch is stacked on it. Two refs in the same stack share a diff, so
// they are one witness, not two.
export function buildStacks(prs, options = {}) {
  const trunkRefs = options.trunkRefs ?? TRUNK_REFS
  const headToNumber = new Map()
  for (const pr of prs) {
    headToNumber.set(pr.headRefName, pr.number)
  }
  const parent = new Map(prs.map((pr) => [pr.number, pr.number]))
  const find = (n) => {
    let root = n
    while (parent.get(root) !== root) {
      root = parent.get(root)
    }
    return root
  }
  const union = (a, b) => {
    const left = find(a)
    const right = find(b)
    if (left !== right) {
      parent.set(left, right)
    }
  }
  // Siblings on one non-trunk base share that base's diff whether or not the base
  // itself is in this list. Grouping only by listed parents counts two children of
  // an unlisted parent as two independent stacks, so the corroboration the
  // `broken` and `upstream` verdicts rest on is one witness counted twice.
  const firstOnBase = new Map()
  for (const pr of prs) {
    const baseRef = pr.baseRefName
    if (baseRef === null || baseRef === undefined || trunkRefs.has(baseRef)) {
      continue
    }
    if (baseRef === pr.headRefName) {
      continue
    }
    const listedParent = headToNumber.get(baseRef)
    if (listedParent !== undefined && listedParent !== pr.number) {
      union(pr.number, listedParent)
    }
    const sibling = firstOnBase.get(baseRef)
    if (sibling === undefined) {
      firstOnBase.set(baseRef, pr.number)
    } else {
      union(pr.number, sibling)
    }
  }
  const groups = new Map()
  for (const pr of prs) {
    const root = find(pr.number)
    if (!groups.has(root)) {
      groups.set(root, [])
    }
    groups.get(root).push(pr.number)
  }
  return [...groups.values()].map((members) => members.sort((a, b) => a - b))
}

// Wall-clock spread between the earliest and latest witness. Returns null when
// fewer than two witnesses carry a timestamp, so callers cannot read a missing
// span as a tight one.
export function evidenceSpanHours(witnesses) {
  const stamps = witnesses
    .map((w) => w.completedAt)
    .filter((s) => s !== null && s !== undefined)
    .map((s) => new Date(s).getTime())
    .filter((t) => Number.isFinite(t))
  if (stamps.length < 2) {
    return null
  }
  return (Math.max(...stamps) - Math.min(...stamps)) / 3600000
}

// How a single check behaved across the witnesses.
export const CHECK_KIND = {
  // Red in every witness that ran it: main was broken for the whole window.
  alwaysRed: 'always-red',
  // Every red falls inside one unbroken stretch of time with no green in it:
  // main broke at the start of that stretch. Covers a break that is still open
  // (no greens after), one that was fixed (greens after), and one that both
  // opened and closed inside the window.
  windowed: 'windowed',
  // Greens fall inside the red stretch: the branches differ, not main.
  interleaved: 'interleaved',
  // Too few witnesses or stacks to attribute either way.
  tooNarrow: 'too-narrow'
}

function timeOf(w) {
  const t =
    w.completedAt === null || w.completedAt === undefined
      ? Number.NaN
      : new Date(w.completedAt).getTime()
  return Number.isFinite(t) ? t : null
}

// Classifies one check name by whether its reds and greens separate cleanly in
// time. A clean split is a main-side transition; interleaving is branch-specific.
function classifyOneCheck(name, usable, minWitnesses) {
  const red = usable.filter((w) => w.failures.includes(name))
  const green = usable.filter((w) => !w.failures.includes(name) && w.ran.includes(name))
  const redStacks = new Set(red.map((w) => w.stackId ?? w.ref))
  const redTimes = red.map(timeOf).filter((t) => t !== null)
  const greenTimes = green.map(timeOf).filter((t) => t !== null)
  const base = {
    name,
    redRefs: red.map((w) => w.ref),
    greenRefs: green.map((w) => w.ref),
    redStacks: redStacks.size,
    firstRed: redTimes.length > 0 ? Math.min(...redTimes) : null,
    lastRed: redTimes.length > 0 ? Math.max(...redTimes) : null,
    firstGreen: greenTimes.length > 0 ? Math.min(...greenTimes) : null,
    lastGreen: greenTimes.length > 0 ? Math.max(...greenTimes) : null
  }
  // A green inside the red stretch means the tree was fine there, so the reds
  // around it belong to their own branches. This is checked before the witness
  // thresholds: one red against many greens is branch-specific evidence, not
  // thin evidence, and calling it `too-narrow` would make `clean` unreachable.
  const greenInsideRedStretch =
    base.firstRed !== null && greenTimes.some((t) => t >= base.firstRed && t <= base.lastRed)
  if (greenInsideRedStretch) {
    return { ...base, kind: CHECK_KIND.interleaved }
  }
  if (base.firstRed === null) {
    return { ...base, kind: CHECK_KIND.tooNarrow, reason: 'no red carries a timestamp' }
  }
  // A red confined to one stack with greens on both sides of it: main would have
  // had to break and be fixed between two adjacent witnesses, which no other
  // branch could have inherited. That makes it the branch's own failure.
  const bracketedByGreens =
    greenTimes.some((t) => t < base.firstRed) && greenTimes.some((t) => t > base.lastRed)
  if (redStacks.size < minWitnesses && bracketedByGreens) {
    return { ...base, kind: CHECK_KIND.interleaved }
  }
  if (red.length < minWitnesses || redStacks.size < minWitnesses) {
    return {
      ...base,
      kind: CHECK_KIND.tooNarrow,
      reason:
        redStacks.size < minWitnesses
          ? `red in only ${redStacks.size} independent stack(s)`
          : `red in only ${red.length} witness(es)`
    }
  }
  if (green.length === 0) {
    return { ...base, kind: CHECK_KIND.alwaysRed }
  }
  return {
    ...base,
    kind: CHECK_KIND.windowed,
    lastGreenBefore: Math.max(
      ...greenTimes.filter((t) => t < base.firstRed),
      Number.NEGATIVE_INFINITY
    ),
    firstGreenAfter: Math.min(
      ...greenTimes.filter((t) => t > base.lastRed),
      Number.POSITIVE_INFINITY
    )
  }
}

// True when `main` is known broken for this check at time `at` (ms). The blind
// gaps on either side of the red stretch answer false, not true.
export function brokenAt(check, at) {
  if (check.kind === CHECK_KIND.alwaysRed) {
    return true
  }
  if (check.kind === CHECK_KIND.windowed) {
    return at >= check.firstRed && at <= check.lastRed
  }
  return false
}

// Per-check attribution across witnesses.
export function classifyChecks(witnesses, options = {}) {
  const minWitnesses = options.minWitnesses ?? MIN_WITNESSES
  const usable = witnesses.filter((w) => w.usable)
  const names = new Set()
  for (const w of usable) {
    for (const name of w.failures) {
      names.add(name)
    }
  }

  const checks = [...names].sort().map((name) => classifyOneCheck(name, usable, minWitnesses))
  const upstream = checks.filter((c) => c.kind === CHECK_KIND.alwaysRed)
  const transitions = checks.filter((c) => c.kind === CHECK_KIND.windowed)
  const branchSpecific = checks.filter((c) => c.kind === CHECK_KIND.interleaved)
  const inconclusive = checks.filter((c) => c.kind === CHECK_KIND.tooNarrow)

  const failing = usable.filter((w) => w.failures.length > 0)
  const signatures = new Set(failing.map((w) => w.failures.join(' ')))
  const failingStacks = new Set(failing.map((w) => w.stackId ?? w.ref))

  return {
    checks,
    upstream,
    transitions,
    branchSpecific,
    inconclusive,
    evidenceSpanHours: evidenceSpanHours(usable),
    identicalAcrossFailing: failing.length >= minWitnesses && signatures.size === 1,
    failingWitnesses: failing.length,
    failingStacks: failingStacks.size,
    usableWitnesses: usable.length,
    totalWitnesses: witnesses.length,
    independentStacks: new Set(usable.map((w) => w.stackId ?? w.ref)).size
  }
}

// Rejects evidence whose checks are too far apart in time to have observed the
// same `main`. Returns null when the span is acceptable.
function staleEvidenceVerdict(classification, options) {
  const maxSpan = options.maxSpanHours ?? MAX_EVIDENCE_SPAN_HOURS
  const span = classification.evidenceSpanHours
  if (span === null || span === undefined) {
    return { verdict: VERDICT.unknown, why: 'fewer than two witnesses carry a check timestamp' }
  }
  if (span > maxSpan) {
    return {
      verdict: VERDICT.unknown,
      why: `witness checks span ${span.toFixed(1)}h (max ${maxSpan}h); they ran against different mains, so agreeing failures prove nothing`
    }
  }
  return null
}

// `compare` verdict: are these branches red for the same reason or different ones?
export function compareVerdict(classification, options = {}) {
  const minWitnesses = options.minWitnesses ?? MIN_WITNESSES
  if (classification.usableWitnesses < minWitnesses) {
    return {
      verdict: VERDICT.unknown,
      why: `only ${classification.usableWitnesses} of ${classification.totalWitnesses} refs ran a lane that exercises the tree (need ${minWitnesses})`
    }
  }
  if (classification.failingWitnesses === 0) {
    return { verdict: VERDICT.noFailures, why: 'no real failures on any ref' }
  }
  const stale = staleEvidenceVerdict(classification, options)
  if (stale !== null) {
    return stale
  }
  if (classification.failingWitnesses < minWitnesses) {
    return {
      verdict: VERDICT.unknown,
      why: `only ${classification.failingWitnesses} ref is failing; a single red ref cannot be told apart from upstream breakage`
    }
  }
  if (!classification.identicalAcrossFailing) {
    return {
      verdict: VERDICT.divergent,
      why: 'failing refs do not share one failure set, so at least part of the damage is branch-specific'
    }
  }
  if (classification.failingStacks < minWitnesses) {
    return {
      verdict: VERDICT.sharedAncestor,
      why: 'identical failures, but every failing ref is in one stack: the cause is at or below that stack root (main, or the root PR itself)'
    }
  }
  return {
    verdict: VERDICT.upstream,
    why: 'identical failure set across independent stacks; damage from a merge varies with what each branch changed, so this is upstream'
  }
}

// A commit sitting between the last green and the first red of a break — or
// between the last red and the green that follows — is in the blind gap: no
// witness observed main there, so the answer is unknown, not clean.
function inBlindGap(check, at) {
  if (check.kind !== CHECK_KIND.windowed) {
    return false
  }
  const beforeGap = at > check.lastGreenBefore && at < check.firstRed
  const afterGap = at > check.lastRed && at < check.firstGreenAfter
  return beforeGap || afterGap
}

// `at` verdict: was main broken at this commit? Never returns `clean` without
// positive evidence from enough independent witnesses.
export function mainHealthVerdict(classification, at, options = {}) {
  const minWitnesses = options.minWitnesses ?? MIN_WITNESSES
  if (classification.usableWitnesses < minWitnesses) {
    return {
      verdict: VERDICT.unknown,
      why: `only ${classification.usableWitnesses} of ${classification.totalWitnesses} witness PRs ran a lane that exercises the tree (need ${minWitnesses})`,
      brokenChecks: []
    }
  }
  if (classification.independentStacks < minWitnesses) {
    return {
      verdict: VERDICT.unknown,
      why: `witnesses span only ${classification.independentStacks} independent stack(s); they share a diff and cannot corroborate each other`,
      brokenChecks: []
    }
  }
  const stale = staleEvidenceVerdict(classification, options)
  if (stale !== null) {
    return { ...stale, brokenChecks: [] }
  }
  const broken = classification.checks.filter((c) => brokenAt(c, at))
  if (broken.length > 0) {
    return {
      verdict: VERDICT.broken,
      why: `${broken.length} check(s) were failing on main at this commit: ${broken.map((c) => c.name).join(', ')}`,
      brokenChecks: broken.map((c) => c.name)
    }
  }
  const gaps = classification.checks.filter((c) => inBlindGap(c, at))
  if (gaps.length > 0) {
    return {
      verdict: VERDICT.unknown,
      why: `${gaps.length} check(s) changed state inside this window with no witness at the commit itself: ${gaps.map((c) => c.name).join(', ')}`,
      brokenChecks: []
    }
  }
  if (classification.inconclusive.length > 0) {
    return {
      verdict: VERDICT.unknown,
      why: `${classification.inconclusive.length} failing check(s) were seen too narrowly to attribute; treat main as unproven`,
      brokenChecks: []
    }
  }
  return {
    verdict: VERDICT.clean,
    why: `${classification.usableWitnesses} witnesses across ${classification.independentStacks} independent stacks; every check that failed here failed only on its own branch`,
    brokenChecks: []
  }
}

// Keeps the PRs whose CI actually completed inside the window. A PR merged in
// the window may have last run CI days earlier, against a different `main`.
export function selectWitnessesInWindow(witnesses, from, to) {
  return witnesses.filter((w) => {
    if (w.completedAt === null || w.completedAt === undefined) {
      return false
    }
    const at = new Date(w.completedAt).getTime()
    return at >= from.getTime() && at <= to.getTime()
  })
}
