import { execFile, execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import {
  MAX_EVIDENCE_SPAN_HOURS,
  VERDICT,
  buildStacks,
  classifyChecks,
  compareVerdict,
  mainHealthVerdict,
  normalizeChecks,
  selectWitnessesInWindow
} from './upstream-breakage-evidence.mjs'

// CLI over the upstream-breakage evidence model: talks to gh and git, prints the
// witness table, and reports a verdict. See
// docs/reference/upstream-breakage-diagnosis.md.

const GH_BUFFER_BYTES = 32 * 1024 * 1024
// Enough parallelism to keep a 40-witness window inside a few seconds without
// tripping GitHub's secondary rate limits.
const FETCH_CONCURRENCY = 8

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: GH_BUFFER_BYTES })
}

function ghAsync(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { encoding: 'utf8', maxBuffer: GH_BUFFER_BYTES }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

const CHECK_RUN_JQ =
  '.check_runs[] | {name, status, conclusion, completedAt: .completed_at, appSlug: .app.slug}'

async function fetchCheckRuns(sha, { allAttempts }) {
  const filter = allAttempts === true ? 'all' : 'latest'
  const raw = await ghAsync([
    'api',
    `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100&filter=${filter}`,
    '--paginate',
    '--jq',
    CHECK_RUN_JQ
  ])
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

// Bounded-concurrency map; keeps the probe in the seconds range for wide windows.
async function mapWithConcurrency(items, worker) {
  const results = Array.from({ length: items.length })
  let next = 0
  const runners = Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(runners)
  return results
}

const PR_FIELDS = 'number,headRefName,headRefOid,baseRefName,mergedAt,title,url'

// Always passes an explicit limit and reports the count, because `gh pr list`
// silently truncates at 30 and a truncated population reads as a complete one.
function listPullRequests(extraArgs, limit) {
  const prs = JSON.parse(
    gh(['pr', 'list', '--limit', String(limit), '--json', PR_FIELDS, ...extraArgs])
  )
  return { prs, truncated: prs.length >= limit, limit }
}

function viewPullRequest(number) {
  return JSON.parse(gh(['pr', 'view', String(number), '--json', PR_FIELDS]))
}

function resolveCommit(rev) {
  // Never derive a SHA from an abbreviation by hand; let git verify it.
  return git(['rev-parse', '--verify', `${rev}^{commit}`])
}

async function witnessesFromPrs(prs, options) {
  return mapWithConcurrency(prs, async (pr) => ({
    ref: `#${pr.number}`,
    pr,
    ...normalizeChecks(await fetchCheckRuns(pr.headRefOid, options), options)
  }))
}

function attachStacks(witnesses) {
  const stacks = buildStacks(witnesses.map((w) => w.pr))
  const stackOf = new Map()
  for (const [index, members] of stacks.entries()) {
    for (const number of members) {
      stackOf.set(number, `stack-${index + 1}`)
    }
  }
  return witnesses.map((w) => ({ ...w, stackId: stackOf.get(w.pr.number) ?? w.ref }))
}

function describeWitness(w) {
  if (!w.usable) {
    if (w.incomplete > 0) {
      return `no verdict (${w.incomplete} check(s) not completed)`
    }
    return w.ran.length === 0
      ? 'no verdict (nothing ran; path filters skipped every job)'
      : `no verdict (no lane exercised the tree; only ${w.ran.join(', ')} ran)`
  }
  return w.failures.length === 0
    ? `green (${w.ran.length} checks ran)`
    : `RED: ${w.failures.join(', ')}`
}

function printWitnesses(witnesses) {
  // Chronological: a main-side break shows up as greens above and reds below.
  const ordered = [...witnesses].sort((a, b) =>
    String(a.completedAt).localeCompare(String(b.completedAt))
  )
  for (const w of ordered) {
    const at =
      w.completedAt === null || w.completedAt === undefined
        ? '?'
        : clock(new Date(w.completedAt).getTime())
    console.log(`  ${at}  ${w.ref} [${w.stackId}] ${describeWitness(w)}`)
    const dropped = [
      ...new Set([
        ...w.excluded.rollup.map((n) => `${n} (roll-up)`),
        ...w.excluded.knownFalse.map((n) => `${n} (known-false red)`),
        ...w.excluded.foreignApp.map((n) => `${n} (third-party app)`),
        // Printed so a renamed lane that dropped out of the witnessing list is
        // visible rather than quietly costing the run its evidence.
        ...(w.excluded.nonWitnessing ?? []).map((n) => `${n} (does not exercise the tree)`)
      ])
    ]
    if (dropped.length > 0) {
      console.log(`      excluded: ${dropped.join('; ')}`)
    }
  }
}

function clock(ms) {
  return ms === null ? '?' : `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)}Z`
}

function printClassification(c) {
  if (c.upstream.length > 0) {
    console.log('\nRed in every witness that ran it — main was broken for this whole window:')
    for (const u of c.upstream) {
      console.log(`  ${u.name}  — red in ${u.redRefs.join(', ')}`)
    }
  }
  if (c.transitions.length > 0) {
    console.log('\nRed for one unbroken stretch — main was broken across that stretch:')
    for (const t of c.transitions) {
      const opened = Number.isFinite(t.lastGreenBefore)
        ? `after ${clock(t.lastGreenBefore)}`
        : 'before the window'
      const closed = Number.isFinite(t.firstGreenAfter)
        ? `by ${clock(t.firstGreenAfter)}`
        : 'still open'
      console.log(
        `  ${t.name}  — red ${clock(t.firstRed)}..${clock(t.lastRed)} (broke ${opened}; fixed ${closed})`
      )
      console.log(`      red: ${t.redRefs.join(', ')}`)
    }
  }
  if (c.branchSpecific.length > 0) {
    console.log('\nReds and greens interleave in time — branch-specific, not main:')
    for (const b of c.branchSpecific) {
      console.log(
        `  ${b.name}  — red in ${b.redRefs.join(', ')}; green in ${b.greenRefs.join(', ')}`
      )
    }
  }
  if (c.inconclusive.length > 0) {
    console.log('\nSeen too narrowly to attribute:')
    for (const i of c.inconclusive) {
      console.log(`  ${i.name}  — red in ${i.redRefs.join(', ')}; ${i.reason}`)
    }
  }
}

export function parseArgs(argv) {
  const options = {
    mode: argv[0] ?? null,
    refs: [],
    commit: null,
    windowHours: 3,
    limit: 100,
    maxSpanHours: MAX_EVIDENCE_SPAN_HOURS,
    allAttempts: false,
    includeKnownFalse: false,
    json: false
  }
  const rest = argv.slice(1)
  while (rest.length > 0) {
    const arg = rest.shift()
    if (arg === '--window-hours') {
      options.windowHours = Number(rest.shift())
    } else if (arg === '--limit') {
      options.limit = Number(rest.shift())
    } else if (arg === '--max-span-hours') {
      options.maxSpanHours = Number(rest.shift())
    } else if (arg === '--all-attempts') {
      options.allAttempts = true
    } else if (arg === '--include-known-false') {
      options.includeKnownFalse = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag: ${arg}`)
    } else if (options.mode === 'at' && options.commit === null) {
      options.commit = arg
    } else {
      options.refs.push(arg.replace(/^#/, ''))
    }
  }
  return options
}

const USAGE = `Usage:
  node config/scripts/upstream-breakage-probe.mjs at <commit> [--window-hours N] [--limit N]
  node config/scripts/upstream-breakage-probe.mjs compare <pr-number> ...

  at       Was main broken at/near this commit? Reconstructed from the PRs whose
           CI ran against main in the surrounding window.
  compare  Do these red branches share one failure set (upstream) or not?

Flags:
  --window-hours N        witness window for \`at\` (default 3)
  --limit N               explicit gh pr list limit (default 100)
  --max-span-hours N      reject evidence spread wider than this (default ${MAX_EVIDENCE_SPAN_HOURS})
  --all-attempts          include earlier check attempts a re-run to green hid
  --include-known-false   count the known-false reds instead of excluding them
  --json                  machine-readable output

Verdicts never default to pass: without enough evidence the answer is "unknown".`

function describeSpan(classification) {
  return classification.evidenceSpanHours === null
    ? 'evidence span: unknown (fewer than two timestamps)'
    : `evidence span: ${classification.evidenceSpanHours.toFixed(1)}h`
}

async function runCompare(options) {
  if (options.refs.length === 0) {
    throw new Error('compare needs at least one PR number')
  }
  const selected = options.refs.map(Number).map(viewPullRequest)
  const witnesses = attachStacks(await witnessesFromPrs(selected, options))
  const classification = classifyChecks(witnesses)
  const verdict = compareVerdict(classification, options)

  if (options.json) {
    console.log(JSON.stringify({ mode: 'compare', verdict, classification, witnesses }, null, 2))
    return
  }

  console.log(
    `Compared ${witnesses.length} ref(s) across ${classification.independentStacks} independent stack(s); ${describeSpan(classification)}.`
  )
  printWitnesses(witnesses)
  printClassification(classification)
  console.log(`\nVERDICT: ${verdict.verdict} — ${verdict.why}`)
  if (verdict.verdict === VERDICT.upstream) {
    console.log('Next step: merge a newer main into each branch. Do not repair the branches.')
  }
  if (verdict.verdict === VERDICT.sharedAncestor) {
    console.log(
      'Next step: compare against a red PR from a different stack, or probe the stack root with `at`.'
    )
  }
}

async function runAt(options) {
  if (options.commit === null) {
    throw new Error('at needs a commit')
  }
  const sha = resolveCommit(options.commit)
  const when = new Date(git(['show', '-s', '--format=%cI', sha]))
  const windowMs = options.windowHours * 3600 * 1000
  const from = new Date(when.getTime() - windowMs)
  const to = new Date(when.getTime() + windowMs)

  const { prs, truncated, limit } = listPullRequests(['--state', 'merged'], options.limit)
  // CI completes before the merge, so preselect generously and let the
  // completion-time filter below decide.
  const candidates = prs.filter((pr) => {
    if (pr.mergedAt === null || pr.mergedAt === undefined) {
      return false
    }
    const merged = new Date(pr.mergedAt).getTime()
    return merged >= from.getTime() && merged <= to.getTime() + windowMs
  })

  const fetched = await witnessesFromPrs(candidates, options)
  const witnesses = attachStacks(selectWitnessesInWindow(fetched, from, to))
  const classification = classifyChecks(witnesses)
  const verdict = mainHealthVerdict(classification, when.getTime(), options)

  if (options.json) {
    console.log(
      JSON.stringify(
        { mode: 'at', sha, window: { from, to }, verdict, classification, witnesses },
        null,
        2
      )
    )
    return
  }

  console.log(`main @ ${sha} (${when.toISOString()})`)
  console.log(
    `Scanned ${prs.length} merged PR(s) at gh limit ${limit}; ${candidates.length} merged near the window, ${witnesses.length} with CI inside ±${options.windowHours}h, ${classification.usableWitnesses} usable across ${classification.independentStacks} independent stack(s); ${describeSpan(classification)}.`
  )
  if (truncated) {
    console.log(
      `  WARNING: gh pr list returned exactly ${limit} rows (the limit); the window may be truncated — raise --limit.`
    )
  }
  printWitnesses(witnesses)
  printClassification(classification)
  console.log(`\nVERDICT: main was ${verdict.verdict} at this commit — ${verdict.why}`)
  if (verdict.verdict === VERDICT.broken) {
    console.log(
      'A branch red on these checks is inheriting main. Merge a newer main; do not repair the branch.'
    )
  }
  if (verdict.verdict === VERDICT.unknown) {
    console.log(
      'Unknown is not green. Widen --window-hours, or use `compare` on the red branches directly.'
    )
  }
}

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (options.mode === 'at') {
    await runAt(options)
    return
  }
  if (options.mode === 'compare') {
    await runCompare(options)
    return
  }
  console.error(USAGE)
  process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message ?? error)
    process.exitCode = 1
  })
}
