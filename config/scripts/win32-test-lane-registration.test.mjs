import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { scanSourceTree, stripComments } from '../../src/shared/source-scan/source-tree-scan'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

/**
 * Every Windows-gated test file must be registered in BOTH Windows-lane lists.
 *
 * PR CI has exactly one job on a Windows runner -- asserted below on any
 * `runs-on` spelling that could land there, because that premise is what makes
 * this guard meaningful -- and it runs a curated explicit file list. Everything else runs on `ubuntu-latest`, where a Windows-gated
 * suite self-skips and reports success. So a new Windows-gated file that nobody
 * registers executes on no machine and passes green, silently. A recent
 * security effort added six such files; five ran nowhere, including one whose
 * whole point was asserting a native addon's bytes no longer contain a flagged
 * primitive. Registering the instances did not hold -- a sixth arrived from
 * unrelated work while the first five were being fixed -- so the class needs a
 * guard.
 *
 * Both lists matter and being in one is not enough: `WINDOWS_PACKAGE_TESTS` in
 * pr-code-change-scope.mjs decides whether the `package_windows` job RUNS at
 * all for a diff, and the workflow step's vitest argv decides whether the FILE
 * runs once the job started.
 *
 * WHAT THIS DETECTS -- a file is Windows-gated when its name is `*.win32.test.*`
 * / `*.win32.spec.*`, or when it contains ANY suite-level gate, nested ones
 * included, spelled:
 *   - `describe.runIf(<true only on win32>)`, `describe.skipIf(<false only on win32>)`
 *   - `const d = <true only on win32> ? describe : describe.skip`, and the
 *     `? describe.skip : describe` inversion
 * where the condition is `process.platform === 'win32'` / `!== 'win32'`, a
 * compound `<win32 check> && <anything>`, or a `const`/`let` in the same file
 * assigned from either -- so `const RUN_REAL = platform === 'win32' && env…`
 * used as `describe.runIf(RUN_REAL)` is detected, whatever the flag is named
 * and whichever polarity it was written in. Quote style, spacing and the
 * `describe`/`suite` spelling are tolerated. Nested gates count because the
 * Windows lane runs whole files: a win32-only block buried three levels down
 * still runs on no machine unless the file is registered.
 *
 * WHAT THIS CANNOT DETECT -- known blind spots, each deliberate:
 *   - `it`/`test`-level gates. A single win32-only case inside a cross-platform
 *     suite still leaves the file running its other cases on ubuntu, and
 *     pulling all such files -- about thirty, though the figure moves with
 *     which gate spellings you count, so do not lean on it -- into the serial
 *     Windows job is not the trade CI wants. This is the largest limit, and it
 *     is a policy choice, not an oversight: a suite-level gate means a whole
 *     block exists only for Windows, which is the shape worth a lane entry.
 *   - a gate whose condition crosses a module boundary or a function call --
 *     an imported flag, an imported `describeOnWindows`, `isWindows()`.
 *     `legacy-wsl-runtime-auth-drain-apply-script.test.ts` imports its
 *     `isWindows`; it happens to be a POSIX-only gate, so nothing is missed
 *     today, but a win32-only one written that way would be.
 *   - `runIf(<win32> || <x>)` and `skipIf(<not win32> && <x>)` are rejected on
 *     purpose: both can run off Windows, so neither is a win32-only gate. That
 *     holds whether the condition is written at the gate or routed through a
 *     named flag -- the two spellings used to disagree.
 *   - whether a registered suite EXECUTES. Registration is what is asserted. A
 *     suite gated on win32 plus an env var stays skipped on the CI runner even
 *     when registered -- see MANUAL_OPT_IN -- and a path registered but gated
 *     for another platform is not caught either.
 *   - whether the `package_windows` job is triggered for a given diff, or
 *     whether the registered test asserts anything worth running.
 *
 * Growth of the two grandfathered lists is capped by literals, but only review
 * stops someone raising a cap. The caps make that an explicit, visible edit.
 */

const projectDir = resolve(import.meta.dirname, '../..')
const WINDOWS_LANE_JOB = 'package_windows'
const WINDOWS_LANE_STEP = 'Test Windows-specific boundaries'
const WINDOWS_LANE_RUNNER = 'windows-2022'

/**
 * Windows-gated files that predate this guard and are registered in neither
 * list. Shrink-only: registering one means deleting its line here. Never add.
 */
const UNREGISTERED_ON_MAIN = [
  // Suite gated with `describe.skipIf(platform !== 'win32')`; the cross-platform
  // half of the file still runs on ubuntu, the Windows half runs nowhere.
  'src/main/antigravity/windows-hook-payload-delivery.test.ts',
  // `.win32.test.ts` by name yet in neither list -- the plainest instance of the class.
  'src/main/daemon/node-pty-windows-input-error.win32.test.ts',
  // Same shape as the antigravity file: a win32-only sibling suite that never runs.
  'src/main/grok/windows-grok-hook-script.test.ts',
  // Whole file is `describe.runIf(platform === 'win32')`; runs on no machine.
  'src/main/ipc/preflight-windows-path-refresh.repro.test.ts',
  // Nested `describe.skipIf(!isWindows)` real-shell block; never exercised in CI.
  'src/main/ipc/pty-encoding.test.ts',
  // `describeWindows` ternary over the whole file; runs on no machine.
  'src/main/providers/windows-shell-preflight-runtime.windows.test.ts',
  // Whole file is `describe.runIf(platform === 'win32')`; runs on no machine.
  'src/main/startup/windows-shell-path-restoration.windows.test.ts',
  // Whole file is `describe.skipIf(platform !== 'win32')`; runs on no machine.
  'src/shared/setup-agent-sequencing.windows.test.ts'
]

/**
 * Windows-gated suites that ALSO require an opt-in env var, so registering them
 * would not make them execute -- they are run by hand against a real distro or
 * a real filesystem. Excluded deliberately and visibly rather than by accident
 * of a regex; each entry is asserted below to be genuinely env-gated, so this
 * list cannot become a place to park a file someone did not want to register.
 */
const MANUAL_OPT_IN = [
  // `runIf(platform === 'win32' && Boolean(distro))`, distro from ORCA_TEST_WSL_DISTRO.
  'src/main/git/runner-wsl-linked-gitdir-windows.test.ts',
  // `runRealWsl = … && ORCA_REAL_WSL_BANNER_TEST === '1'`; needs a real distro.
  'src/main/local-worktree-filesystem-wsl-banner.wsl.test.ts',
  // `RUN_REAL_WINDOWS = platform === 'win32' && ORCA_REAL_WINDOWS_SKILL_TEST === '1'`.
  'src/main/skills/skill-windows-rename-contention.integration.test.ts',
  // Same flag; installs into a real Windows workspace.
  'src/main/skills/skill-windows-workspace.integration.test.ts',
  // `RUN_REAL_WSL = … && ORCA_REAL_WSL_SKILL_TEST === '1'`; real distro filesystem.
  'src/main/skills/skill-wsl-delete.integration.test.ts',
  // Same flag; real WSL install transactions.
  'src/main/skills/skill-wsl-install-transaction.integration.test.ts',
  // Same flag; real WSL POSIX semantics.
  'src/main/skills/skill-wsl-posix-semantics.integration.test.ts',
  // `runRealWsl = … && ORCA_REAL_WSL_DELETE_TEST === '1'`; real distro traversal race.
  'src/main/wsl-approved-root-race.wsl.test.ts',
  // Same flag; real UNC delete against a distro.
  'src/main/wsl-unc-delete.wsl.test.ts',
  // `enabled = platform === 'win32' && ORCA_REAL_WSL_RUNNER_TEST === '1'`; mutates a real distro's ~/.profile.
  'src/main/wsl/wsl-runner.wsl.test.ts'
]

/** Caps so growing either list is two deliberate edits, not one. */
const UNREGISTERED_MAX = 8
const MANUAL_OPT_IN_MAX = 10

/**
 * Floor for the Windows-gated population, so a broken walk or a regex that
 * stops matching cannot make the guard pass by finding nothing. Only ever
 * lowered, and only when a gated file is genuinely deleted.
 */
const GATED_FILE_FLOOR = 23

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|mjs|cjs|js)$/

/**
 * Mobile has its own vitest run and never touches the desktop Windows job:
 * `classifyPrJobs` reports `package_windows: false` for every `mobile/` path,
 * so a gated file there could not satisfy this guard even in principle.
 */
const UNREACHABLE_BY_THE_WINDOWS_LANE = 'mobile/'

/**
 * This file quotes every gate spelling as a fixture, so it matches its own
 * matcher. It is not gated -- it must run on ubuntu, since a guard about
 * Windows CI that only ran on Windows would be self-defeating. Exempt by exact
 * path, never by directory, so a real gated file in config/scripts is caught.
 */
const SCANNER_SELF_PATH = 'config/scripts/win32-test-lane-registration.test.mjs'

export function isScannerSelfPath(path) {
  return path === SCANNER_SELF_PATH
}

const WIN32_TRUE_EXPRESSION = String.raw`process\.platform\s*===\s*['"]win32['"]`
const WIN32_FALSE_EXPRESSION = String.raw`process\.platform\s*!==\s*['"]win32['"]`
const SUITE = String.raw`(?:describe|suite)`

/**
 * Named flags resolved from their assignment in the same file, so polarity is
 * read rather than guessed from the name.
 *
 * Why the trailing lookahead: `const d = platform === 'win32' ? describe : …`
 * is a suite alias, not a boolean, and must not be collected as one.
 *
 * Why the two patterns differ on `&&`: a second conjunct NARROWS a
 * truthy-on-Windows flag, which stays Windows-only, but WIDENS a
 * falsy-on-Windows one -- `p = platform !== 'win32' && x` used as `skipIf(p)`
 * runs on Windows AND on POSIX whenever `x` is false, so it is not a
 * Windows-only gate. One lookahead shared across both polarities had that
 * backwards, and routing the condition through a named flag flipped the answer
 * the literal form got right. `||` is excluded from both.
 */
const FLAG_TRUE_ASSIGNMENT = new RegExp(
  String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${WIN32_TRUE_EXPRESSION}(?=\s*(?:&&|;|\r?\n|$))`,
  'g'
)
const FLAG_FALSE_ASSIGNMENT = new RegExp(
  String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${WIN32_FALSE_EXPRESSION}(?=\s*(?:;|\r?\n|$))`,
  'g'
)

function escapeForAlternation(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Never-matching branch, so an empty flag set cannot widen a pattern. */
const MATCHES_NOTHING = String.raw`(?!)`

function alternation(names) {
  return names.length === 0 ? MATCHES_NOTHING : names.map(escapeForAlternation).join('|')
}

function buildGates(source) {
  const trueOnWindows = [...source.matchAll(FLAG_TRUE_ASSIGNMENT)].map(([, name]) => name)
  const falseOnWindows = [...source.matchAll(FLAG_FALSE_ASSIGNMENT)].map(([, name]) => name)
  const isTrue = `(?:${WIN32_TRUE_EXPRESSION}|\\b(?:${alternation(trueOnWindows)})\\b)`
  const isFalse = `(?:${WIN32_FALSE_EXPRESSION}|!\\s*(?:${alternation(trueOnWindows)})\\b|\\b(?:${alternation(falseOnWindows)})\\b)`
  return [
    // `\)` or `&&` after the condition: a bare gate, or a compound one whose
    // remaining conjuncts only narrow it further. Anchoring on `\)` alone was
    // this guard's own bug -- `runIf(win32 && hasAddon)` went undetected.
    new RegExp(String.raw`\b${SUITE}\s*\.\s*runIf\s*\(\s*${isTrue}\s*(?:\)|&&)`),
    new RegExp(String.raw`\b${SUITE}\s*\.\s*skipIf\s*\(\s*${isFalse}\s*(?:\)|\|\|)`),
    // `(?!\s*\.\s*skip)`: `platform === 'win32' ? describe.skip : describe` is
    // the POSIX-only gate, the exact opposite of the class, and seven files
    // use it.
    new RegExp(String.raw`=\s*${isTrue}\s*\?\s*${SUITE}\s*(?!\s*\.\s*skip)`),
    new RegExp(String.raw`=\s*${isFalse}\s*\?\s*${SUITE}\s*\.\s*skip`)
  ]
}

/** Exported shape of the rule, so the fixtures below exercise the real matcher. */
export function isWindows32GatedTestFile(path, source) {
  if (/\.win32\.(?:test|spec)\./.test(path)) {
    return true
  }
  // Prose about a gate is not a gate; the shared stripper tracks quote state so
  // a slash-star inside a string cannot blank live code.
  const code = stripComments(source)
  return buildGates(code).some((gate) => gate.test(code))
}

/**
 * True when the env read REACHES the gate: the win32 check is compound, and one
 * of its other conjuncts either reads `process.env` itself or names a const
 * that does.
 *
 * "Mentions an env var anywhere in the file" is not enough and was the earlier
 * bug here. `runIf(platform === 'win32' && hasAddon)` in a file that happens to
 * read `process.env.RUNNER_TEMP` for a temp dir is a test CI COULD run -- the
 * native-addon-bytes shape, exactly what this effort exists to keep in CI --
 * and it would have parked in MANUAL_OPT_IN unnoticed. Only the cap number
 * stood in the way, and a number is not an argument.
 *
 * One hop is enough for every real case: `distro = process.env.ORCA_TEST_WSL_DISTRO`
 * then `runIf(platform === 'win32' && Boolean(distro))`. Deeper chains fail
 * closed -- the file reads as registrable, which is the safe direction.
 */
const WIN32_CONJUNCT = new RegExp(String.raw`${WIN32_TRUE_EXPRESSION}\s*&&([^\n]*)`, 'g')
const ENV_READ = /process\.env\.[A-Za-z0-9_]+/
const IDENTIFIER = /[A-Za-z_$][\w$]*/g

function isAssignedFromEnv(name, code) {
  return new RegExp(
    String.raw`(?:const|let|var)\s+${escapeForAlternation(name)}\s*=[^\n]*process\.env\.`
  ).test(code)
}

export function requiresEnvOptIn(source) {
  const code = stripComments(source)
  return [...code.matchAll(WIN32_CONJUNCT)].some(([, conjunct]) => {
    if (ENV_READ.test(conjunct)) {
      return true
    }
    return [...conjunct.matchAll(IDENTIFIER)].some(([name]) => isAssignedFromEnv(name, code))
  })
}

/**
 * Any `runs-on` that could put a job on Windows.
 *
 * Not an equality test against `windows-2022`: `windows-latest` resolves to the
 * same image today, a label array or `{ group, labels }` object is valid YAML
 * here, and a `${{ matrix.os }}` expression cannot be resolved from the file at
 * all. An unresolvable expression counts as "could be Windows" so it fails
 * closed -- someone has to look rather than have a second lane appear silently.
 */
export function couldRunOnWindows(runsOn) {
  const labels =
    typeof runsOn === 'string'
      ? [runsOn]
      : Array.isArray(runsOn)
        ? runsOn
        : [...(runsOn?.labels ?? []), runsOn?.group ?? ''].flat()
  return labels.some((label) => /windows/i.test(String(label)) || String(label).includes('${{'))
}

/** The vitest argv of the one Windows job's one curated-file step. */
function readWindowsWorkflow() {
  const workflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
  const jobs = Object.entries(workflow.jobs ?? {})
  const windowsJobs = jobs.filter(([, job]) => couldRunOnWindows(job?.['runs-on']))
  const steps = workflow.jobs?.[WINDOWS_LANE_JOB]?.steps ?? []
  const step = steps.find((candidate) => candidate?.name === WINDOWS_LANE_STEP)
  if (!step) {
    throw new Error(
      `No "${WINDOWS_LANE_STEP}" step in the ${WINDOWS_LANE_JOB} job of .github/workflows/pr.yml. ` +
        'If it was renamed, update WINDOWS_LANE_STEP here -- do not delete this guard.'
    )
  }
  const run = String(step.run ?? '')
  if (!run.includes('vitest run')) {
    throw new Error(
      `The "${WINDOWS_LANE_STEP}" step no longer invokes vitest; this guard is stale.`
    )
  }
  return {
    windowsJobNames: windowsJobs.map(([name]) => name),
    laneFiles: run.split(/\s+/).filter((token) => TEST_FILE_PATTERN.test(token))
  }
}

const { windowsJobNames, laneFiles } = readWindowsWorkflow()
const scannedTestFiles = scanSourceTree(projectDir, {
  includeTests: true,
  extensions: TEST_FILE_PATTERN
}).filter(({ relativePath }) => !relativePath.startsWith(UNREACHABLE_BY_THE_WINDOWS_LANE))
const gatedFiles = scannedTestFiles
  .filter(({ relativePath }) => !isScannerSelfPath(relativePath))
  .filter(({ relativePath, source }) => isWindows32GatedTestFile(relativePath, source))
  .map(({ relativePath }) => relativePath)

/**
 * Why the classifier and not the literal list: `WINDOWS_PACKAGE_TESTS` is not
 * exported, and the classifier is what CI actually consults. It inherits
 * `classifyPrJobs`'s force-all, so a path under GLOBAL_FORCE_PREFIXES would
 * read as registered without being listed -- no test file is one today.
 */
function isInClassifier(path) {
  return classifyPrJobs([path])[WINDOWS_LANE_JOB] === true
}

function registrationFailure(path) {
  const missing = []
  if (!laneFiles.includes(path)) {
    missing.push(
      `add "${path}" to the "${WINDOWS_LANE_STEP}" vitest argv in .github/workflows/pr.yml ` +
        `(job ${WINDOWS_LANE_JOB})`
    )
  }
  if (!isInClassifier(path)) {
    missing.push(
      `add '${path}' to WINDOWS_PACKAGE_TESTS in config/scripts/pr-code-change-scope.mjs`
    )
  }
  return missing.length === 0 ? null : `${path}: ${missing.join('; and ')}`
}

function sourceOf(path) {
  return readFileSync(join(projectDir, path), 'utf8')
}

describe('Windows-gated test files are registered in the Windows CI lane', () => {
  it('scans a plausible number of test files', () => {
    // A broken root or extension filter would make every assertion below vacuous.
    expect(scannedTestFiles.length).toBeGreaterThan(5000)
  })

  it('has exactly one windows-2022 job to register into', () => {
    // The whole premise: one Windows lane, one curated list. A second lane would
    // mean a file could be registered in the wrong one and still run nowhere.
    expect(
      windowsJobNames,
      `Expected only ${WINDOWS_LANE_JOB} to run on ${WINDOWS_LANE_RUNNER}.`
    ).toEqual([WINDOWS_LANE_JOB])
  })

  it('parses a plausible Windows lane invocation', () => {
    expect(laneFiles.length).toBeGreaterThan(15)
    const missingFromDisk = laneFiles.filter((path) => {
      try {
        return !statSync(join(projectDir, path)).isFile()
      } catch {
        return true
      }
    })
    expect(
      missingFromDisk,
      'The Windows lane invokes vitest on paths that do not exist -- vitest will run nothing for them.'
    ).toEqual([])
  })

  it('rediscovers Windows-gated files that are already registered', () => {
    // Both discovery paths, proven against real files rather than fixtures: one
    // found by filename plus ternary alias, one found only by its gate
    // expression because its name says nothing about Windows gating.
    expect(gatedFiles).toContain('src/shared/child-process/windows-command-line.win32.test.ts')
    expect(gatedFiles).toContain('src/main/agent-hooks/windows-hook-payload-delivery.test.ts')
    // And a compound gate, the case this guard was blind to at first.
    expect(gatedFiles).toContain('src/main/git/runner-wsl-linked-gitdir-windows.test.ts')
  })

  it('exempts itself, and nothing else, from the scan', () => {
    expect(scannedTestFiles.map(({ relativePath }) => relativePath)).toContain(SCANNER_SELF_PATH)
    // The exemption is load-bearing only while the fixtures below still match.
    expect(isWindows32GatedTestFile(SCANNER_SELF_PATH, sourceOf(SCANNER_SELF_PATH))).toBe(true)
    expect(gatedFiles).not.toContain(SCANNER_SELF_PATH)
    // The other half of the claim: no sibling rides the exemption.
    expect(isScannerSelfPath('config/scripts/pr-code-change-scope.test.mjs')).toBe(false)
  })

  it('holds the Windows-gated population at or above the floor', () => {
    // Bounding by the grandfathered lists' lengths would be trivially true --
    // they move together. The floor is a literal for that reason.
    expect(
      gatedFiles.length,
      `Found ${gatedFiles.length} Windows-gated test files; the floor is ${GATED_FILE_FLOOR}. ` +
        'A drop means the scan stopped matching, not that the files went away. Lower the floor ' +
        'only for a genuine deletion.'
    ).toBeGreaterThanOrEqual(GATED_FILE_FLOOR)
  })

  it('confirms the classifier distinguishes registered from unregistered paths', () => {
    // Without this, a classifier that answered true for everything would make
    // the registration assertion below pass for free.
    expect(isInClassifier('src/main/windows/windows-pty-job.win32.test.ts')).toBe(true)
    expect(isInClassifier('src/main/windows/not-a-real-file.win32.test.ts')).toBe(false)
  })

  it('has every Windows-gated test file in both registration lists', () => {
    const grandfathered = new Set([...UNREGISTERED_ON_MAIN, ...MANUAL_OPT_IN])
    const failures = gatedFiles
      .filter((path) => !grandfathered.has(path))
      .map(registrationFailure)
      .filter((failure) => failure !== null)
    expect(
      failures,
      'A Windows-gated test file is missing from a Windows CI registration list. It self-skips on ' +
        'ubuntu and reports success, so it runs on no machine. Both lists are required: ' +
        'WINDOWS_PACKAGE_TESTS decides whether the package_windows job runs for a diff, the ' +
        'workflow argv decides whether the file runs once it started. Fix each line below.'
    ).toEqual([])
  })

  it('has no stale entry in either grandfathered list', () => {
    const stale = [...UNREGISTERED_ON_MAIN, ...MANUAL_OPT_IN].filter(
      (path) => !gatedFiles.includes(path) || registrationFailure(path) === null
    )
    expect(
      stale,
      'These files are no longer unregistered Windows-gated debt -- they were registered, ' +
        'renamed, un-gated, or deleted. Delete each line from UNREGISTERED_ON_MAIN or ' +
        'MANUAL_OPT_IN; the lists only ever shrink.'
    ).toEqual([])
  })

  it('caps growth of both grandfathered lists', () => {
    expect(
      UNREGISTERED_ON_MAIN.length,
      'Never raise UNREGISTERED_MAX. Register the file instead.'
    ).toBeLessThanOrEqual(UNREGISTERED_MAX)
    expect(
      MANUAL_OPT_IN.length,
      'Never raise MANUAL_OPT_IN_MAX to avoid registering a file that CI could actually run.'
    ).toBeLessThanOrEqual(MANUAL_OPT_IN_MAX)
  })

  it('keeps MANUAL_OPT_IN to suites CI genuinely cannot run', () => {
    // Otherwise this list is just a quieter way to skip registration.
    const notActuallyOptIn = MANUAL_OPT_IN.filter((path) => !requiresEnvOptIn(sourceOf(path)))
    expect(
      notActuallyOptIn,
      'A MANUAL_OPT_IN entry has no env-var opt-in, so registering it WOULD make it run. ' +
        'Register it in both lists and delete the line.'
    ).toEqual([])
  })

  it('keeps every UNREGISTERED_ON_MAIN file ineligible for MANUAL_OPT_IN', () => {
    // The two lists must not be interchangeable: debt that CI could run must
    // not be re-labelled as manual to make the debt cap look better.
    const movable = UNREGISTERED_ON_MAIN.filter((path) => requiresEnvOptIn(sourceOf(path)))
    expect(
      movable,
      'This file is registrable; it cannot be reclassified as MANUAL_OPT_IN.'
    ).toEqual([])
  })
})

describe('manual opt-in classification', () => {
  it('requires the env read to reach the gate', () => {
    // The parking attack: a compound gate CI could satisfy, in a file that
    // happens to read an unrelated env var. This is the native-addon-bytes
    // shape, and it must read as registrable.
    expect(
      requiresEnvOptIn(
        "const tmp = process.env.RUNNER_TEMP\ndescribe.runIf(process.platform === 'win32' && hasAddon)('x', () => {})"
      )
    ).toBe(false)
    // One hop through a const: the real shape of the ten listed suites.
    expect(
      requiresEnvOptIn(
        "const distro = process.env.ORCA_TEST_WSL_DISTRO\ndescribe.runIf(process.platform === 'win32' && Boolean(distro))('x', () => {})"
      )
    ).toBe(true)
    // Read inline in the conjunct: the other real shape.
    expect(
      requiresEnvOptIn(
        "const RUN = process.platform === 'win32' && process.env.ORCA_REAL_X === '1'"
      )
    ).toBe(true)
  })

  it('requires the gate to be compound at all', () => {
    // A bare `runIf(win32)` file -- which CI can run -- must never park as
    // manual, however much `process.env` the file reads elsewhere.
    expect(
      requiresEnvOptIn(
        "const t = process.env.CI\ndescribe.runIf(process.platform === 'win32')('x', () => {})"
      )
    ).toBe(false)
    // The case that makes the `&&` in WIN32_CONJUNCT load-bearing rather than
    // decorative: an env read on the SAME line as a bare gate. Drop the `&&`
    // and this reads as manual, which is the parking hole reopened.
    expect(
      requiresEnvOptIn(
        "describe.runIf(process.platform === 'win32')(`x ${process.env.ORCA_TAG}`, () => {})"
      )
    ).toBe(false)
  })
})

describe('Windows runner detection', () => {
  it('reads every runs-on spelling that could land on Windows', () => {
    expect(couldRunOnWindows('windows-2022')).toBe(true)
    // The spelling that would have slipped past an equality test.
    expect(couldRunOnWindows('windows-latest')).toBe(true)
    expect(couldRunOnWindows(['self-hosted', 'Windows', 'X64'])).toBe(true)
    expect(couldRunOnWindows({ group: 'windows-runners', labels: ['x64'] })).toBe(true)
    // Unresolvable from the file, so it fails closed rather than reading as safe.
    expect(couldRunOnWindows('${{ matrix.os }}')).toBe(true)
    expect(couldRunOnWindows('ubuntu-latest')).toBe(false)
    expect(couldRunOnWindows(['self-hosted', 'linux'])).toBe(false)
    expect(couldRunOnWindows(undefined)).toBe(false)
  })
})

describe('Windows-gate detection', () => {
  // Each positive is paired with the near-miss it must reject. The pairs are
  // written from the shapes that exist in the repo, not from the regexes above.
  const cases = [
    [
      'describe.runIf equality',
      "describe.runIf(process.platform === 'win32')('x', () => {})",
      "describe.runIf(process.platform !== 'win32')('x', () => {})"
    ],
    [
      'describe.skipIf inequality',
      "describe.skipIf(process.platform !== 'win32')('x', () => {})",
      "describe.skipIf(process.platform === 'win32')('x', () => {})"
    ],
    [
      'ternary describe alias',
      "const d = process.platform === 'win32' ? describe : describe.skip",
      "const d = process.platform === 'win32' ? describe.skip : describe"
    ],
    [
      'inverted ternary describe alias',
      "const d = process.platform !== 'win32' ? describe.skip : describe",
      "const d = process.platform !== 'win32' ? describe : describe.skip"
    ],
    [
      'local isWindows flag',
      "const isWindows = process.platform === 'win32'\ndescribe.skipIf(!isWindows)('x', () => {})",
      "const isWindows = process.platform === 'win32'\ndescribe.skipIf(isWindows)('x', () => {})"
    ],
    [
      'local isWindows flag, runIf',
      "const isWindows = process.platform === 'win32'\ndescribe.runIf(isWindows)('x', () => {})",
      "const isWindows = process.platform === 'win32'\ndescribe.runIf(!isWindows)('x', () => {})"
    ],
    [
      // The blocking miss: a second conjunct made the gate invisible.
      'compound gate with a second conjunct',
      "describe.runIf(process.platform === 'win32' && Boolean(distro))('x', () => {})",
      "describe.runIf(process.platform === 'win32' || Boolean(distro))('x', () => {})"
    ],
    [
      'compound gate behind a named flag assigned on the next line',
      "const RUN_REAL =\n  process.platform === 'win32' && process.env.X === '1'\ndescribe.runIf(RUN_REAL)('x', () => {})",
      "const RUN_REAL =\n  process.platform !== 'win32' && process.env.X === '1'\ndescribe.runIf(RUN_REAL)('x', () => {})"
    ],
    [
      'named flag driving a ternary suite alias',
      "const enabled = process.platform === 'win32' && process.env.X === '1'\nconst d = enabled ? describe : describe.skip",
      "const enabled = process.platform === 'win32' && process.env.X === '1'\nconst d = enabled ? describe.skip : describe"
    ],
    [
      'compound skipIf widened with ||',
      "describe.skipIf(process.platform !== 'win32' || !hasAddon)('x', () => {})",
      "describe.skipIf(process.platform !== 'win32' && !hasAddon)('x', () => {})"
    ],
    [
      'double-quoted and loosely spaced',
      'describe . runIf ( process.platform === "win32" )("x", () => {})',
      'describe . runIf ( process.platform === "darwin" )("x", () => {})'
    ]
  ]

  for (const [label, gated, nearMiss] of cases) {
    it(`detects ${label} and rejects its near miss`, () => {
      expect(isWindows32GatedTestFile('src/x/sample.test.ts', gated)).toBe(true)
      expect(isWindows32GatedTestFile('src/x/sample.test.ts', nearMiss)).toBe(false)
    })
  }

  it('detects the .win32 filename with no gate expression at all', () => {
    expect(isWindows32GatedTestFile('src/x/sample.win32.test.ts', 'describe("x", () => {})')).toBe(
      true
    )
    // Near miss: `.win32.ts` is production source, not a test the lane can run.
    expect(isWindows32GatedTestFile('src/x/sample.win32.ts', 'export const x = 1')).toBe(false)
  })

  it('does not read a flag whose name merely starts the same', () => {
    // Without word boundaries `isWindows` would swallow `isWindowsHost`.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "const isWindows = process.platform === 'win32'\ndescribe.runIf(isWindowsHost)('x', () => {})"
      )
    ).toBe(false)
  })

  it('rejects the documented blind spots rather than half-detecting them', () => {
    // it-level gate inside a cross-platform suite: out of scope by design.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "describe('x', () => { it.skipIf(process.platform !== 'win32')('y', () => {}) })"
      )
    ).toBe(false)
    // A platform branch inside a test body is not a gate.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "it('x', () => { if (process.platform === 'win32') { return } })"
      )
    ).toBe(false)
    // An imported flag: the assignment is not in this file, so polarity is unknowable.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "import { isWindows } from './f'\ndescribe.runIf(isWindows)('x', () => {})"
      )
    ).toBe(false)
  })

  it('does not treat a widening conjunct behind a named flag as Windows-only', () => {
    // `!== 'win32' && x` skips only when BOTH hold, so the suite runs on
    // Windows and on POSIX when `x` is false. The literal form is rejected by
    // the `||` pair above; this is the same condition routed through a flag,
    // which is where the shared lookahead used to flip the answer.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "const p = process.platform !== 'win32' && Boolean(x)\ndescribe.skipIf(p)('x', () => {})"
      )
    ).toBe(false)
    // The narrowing direction still counts: `=== 'win32' && x` is Windows-only.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "const p = process.platform === 'win32' && Boolean(x)\ndescribe.runIf(p)('x', () => {})"
      )
    ).toBe(true)
  })

  it('ignores a gate that only appears in prose', () => {
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "// describe.runIf(process.platform === 'win32')\ndescribe('x', () => {})"
      )
    ).toBe(false)
  })
})
