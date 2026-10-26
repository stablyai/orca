import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { scanSourceTree, stripComments } from '../../src/shared/source-scan/source-tree-scan'
import { classifyPrJobs } from './pr-code-change-scope.mjs'
import { WINDOWS_BOUNDARY_TESTS } from './pr-package-test-paths.mjs'

// Register every Windows-named or suite-gated file in sole Windows lane’s curated list; otherwise Ubuntu self-skips can pass without execution.
// Follow suite/describe gates, nested aliases, local boolean polarity and narrowing &&; do not follow case-level gates, imported/function flags, broad OR/skipIf conjunctions.
// Proves registration/routing list membership, not actual suite execution (manual env gates can skip), diff-trigger coverage or assertion quality. Literal caps expose allowance growth for review.

const projectDir = resolve(import.meta.dirname, '../..')
const WINDOWS_LANE_JOB = 'package_windows'
const WINDOWS_LANE_STEPS = [
  'Test Windows-specific boundaries',
  'Test Windows installer process probe'
]
const WINDOWS_LANE_RUNNER = 'windows-2022'

// Shrink-only pre-existing Windows files missing lane registration; remove entry when registered, never add.
const UNREGISTERED_ON_MAIN = [
  // Suite gated with `describe.skipIf(platform !== 'win32')`; the cross-platform
  // half of the file still runs on ubuntu, the Windows half runs nowhere.
  'src/main/antigravity/windows-hook-payload-delivery.test.ts',
  // `.win32.test.ts` by name yet not registered -- the plainest instance of the class.
  'src/main/daemon/node-pty-windows-input-error.win32.test.ts',
  // Same shape as the antigravity file: a win32-only sibling suite that never runs.
  'src/main/grok/windows-grok-hook-script.test.ts',
  // Whole file is `describe.runIf(platform === 'win32')`; runs on no machine.
  'src/main/ipc/preflight-windows-path-refresh.repro.test.ts',
  // `describeWindows` ternary over the whole file; runs on no machine.
  'src/main/providers/windows-shell-preflight-runtime.windows.test.ts',
  // Whole file is `describe.runIf(platform === 'win32')`; runs on no machine.
  'src/main/startup/windows-shell-path-restoration.windows.test.ts',
  // Whole file is `describe.skipIf(platform !== 'win32')`; runs on no machine.
  'src/shared/setup-agent-sequencing.windows.test.ts'
]

// Manual suites need real-distro/filesystem opt-in as well as win32; assert env actually reaches gate so this cannot hide registrable debt.
const MANUAL_OPT_IN = [
  // `runIf(platform === 'win32' && Boolean(distro))`, distro from ORCA_TEST_WSL_DISTRO.
  'src/main/git/runner-wsl-linked-gitdir-windows.test.ts',
  // `runRealWsl = … && ORCA_REAL_WSL_BANNER_TEST === '1'`; needs a real distro.
  'src/main/local-worktree-filesystem-wsl-banner.wsl.test.ts',
  // `ORCA_REAL_WINDOWS_SKILL_TEST === '1'`; installs into a real Windows workspace.
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
const MANUAL_OPT_IN_MAX = 9

// Pin population floor against broken discovery; lower only when real gated file is deleted.
const GATED_FILE_FLOOR = 23

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|mjs|cjs|js)$/

// Exclude mobile: separate Vitest job never triggers desktop package_windows lane.
const UNREACHABLE_BY_THE_WINDOWS_LANE = 'mobile/'

// Exempt exact self path because matcher fixtures quote gates; guard must run on Ubuntu and must not exempt real sibling suites.
const SCANNER_SELF_PATH = 'config/scripts/win32-test-lane-registration.test.mjs'

export function isScannerSelfPath(path) {
  return path === SCANNER_SELF_PATH
}

const WIN32_TRUE_EXPRESSION = String.raw`process\.platform\s*===\s*['"]win32['"]`
const WIN32_FALSE_EXPRESSION = String.raw`process\.platform\s*!==\s*['"]win32['"]`
const SUITE = String.raw`(?:describe|suite)`

// Resolve named flag polarity from assignment, excluding ternary suite aliases. Truthy win32 && narrows; falsy non-win32 && widens skipIf to run on POSIX too. Reject || for both.
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
    // Accept bare gate or narrowing &&; requiring only closing parenthesis misses runIf(win32 && hasAddon).
    new RegExp(String.raw`\b${SUITE}\s*\.\s*runIf\s*\(\s*${isTrue}\s*(?:\)|&&)`),
    new RegExp(String.raw`\b${SUITE}\s*\.\s*skipIf\s*\(\s*${isFalse}\s*(?:\)|\|\|)`),
    // Reject inverted describe.skip branch, which gates POSIX rather than Windows.
    new RegExp(String.raw`=\s*${isTrue}\s*\?\s*${SUITE}\s*(?!\s*\.\s*skip)`),
    new RegExp(String.raw`=\s*${isFalse}\s*\?\s*${SUITE}\s*\.\s*skip`)
  ]
}

/** Exported shape of the rule, so the fixtures below exercise the real matcher. */
export function isWindows32GatedTestFile(path, source) {
  if (/\.win32\.(?:test|spec)\./.test(path)) {
    return true
  }
  // Strip actual comments with quote tracking; slash-star in string must not erase live gate.
  const code = stripComments(source)
  return buildGates(code).some((gate) => gate.test(code))
}

// Manual exemption requires env read in same win32 conjunct or one referenced const; unrelated env elsewhere cannot park registrable suite. Deeper chains fail closed as registrable.
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

// Treat any runs-on label/array/group/matrix that may be Windows as a lane; unresolvable expression fails closed for review.
export function couldRunOnWindows(runsOn) {
  const labels =
    typeof runsOn === 'string'
      ? [runsOn]
      : Array.isArray(runsOn)
        ? runsOn
        : [...(runsOn?.labels ?? []), runsOn?.group ?? ''].flat()
  return labels.some((label) => /windows/i.test(String(label)) || String(label).includes('${{'))
}

/** The Windows job's curated files: the boundary list plus any argv the lane steps spell out. */
function readWindowsWorkflow() {
  const workflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
  const jobs = Object.entries(workflow.jobs ?? {})
  const windowsJobs = jobs.filter(([, job]) => couldRunOnWindows(job?.['runs-on']))
  const steps = workflow.jobs?.[WINDOWS_LANE_JOB]?.steps ?? []
  const runs = WINDOWS_LANE_STEPS.map((name) => {
    const step = steps.find((candidate) => candidate?.name === name)
    if (!step) {
      throw new Error(
        `No "${name}" step in ${WINDOWS_LANE_JOB}; update WINDOWS_LANE_STEPS if renamed.`
      )
    }
    const run = String(step.run ?? '')
    if (!/(?:vitest|vitest\.mjs) run/.test(run)) {
      throw new Error(`The "${name}" step no longer invokes vitest; this guard is stale.`)
    }
    return run
  })
  if (!runs[0].includes('config/scripts/pr-package-test-paths.mjs')) {
    throw new Error(`The "${WINDOWS_LANE_STEPS[0]}" step no longer reads WINDOWS_BOUNDARY_TESTS.`)
  }
  const run = runs.join(' ')
  return {
    windowsJobNames: windowsJobs.map(([name]) => name),
    laneFiles: [
      ...WINDOWS_BOUNDARY_TESTS,
      ...run.split(/\s+/).filter((token) => TEST_FILE_PATTERN.test(token))
    ]
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

// Ask actual CI classifier, not private WINDOWS_PACKAGE_TESTS; force-all paths could look registered without listing, though none are test paths today.
function isInClassifier(path) {
  return classifyPrJobs([path])[WINDOWS_LANE_JOB] === true
}

function registrationFailure(path) {
  const missing = []
  if (!laneFiles.includes(path)) {
    missing.push(
      `add '${path}' to WINDOWS_BOUNDARY_TESTS in config/scripts/pr-package-test-paths.mjs`
    )
  }
  if (!isInClassifier(path)) {
    missing.push(
      `add '${path}' to WINDOWS_PACKAGE_TESTS in config/scripts/pr-package-test-paths.mjs`
    )
  }
  return missing.length === 0 ? null : `${path}: ${missing.join('; and ')}`
}

function sourceOf(path) {
  return readFileSync(join(projectDir, path), 'utf8')
}

describe('Windows-gated test files are registered in the Windows CI lane', () => {
  it('enables real Windows rename contention tests in the registered step', () => {
    const workflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
    const step = workflow.jobs.package_windows.steps.find(
      (candidate) => candidate.name === 'Test Windows-specific boundaries'
    )
    expect(step.env.ORCA_REAL_WINDOWS_SKILL_TEST).toBe('1')
    expect(step.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(WINDOWS_BOUNDARY_TESTS).toContain(
      'src/main/skills/skill-windows-rename-contention.integration.test.ts'
    )
  })

  it('scans a plausible number of test files', () => {
    // A broken root or extension filter would make every assertion below vacuous.
    expect(scannedTestFiles.length).toBeGreaterThan(5000)
  })

  it('has exactly one windows-2022 job to register into', () => {
    // Require sole Windows lane so curated registration cannot point at wrong job and silently skip.
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
    // Prove both filename/alias and gate-only discovery against real files, not just fixtures.
    expect(gatedFiles).toContain(
      'src/shared/__tests__/process-host/windows-command-line.win32.test.ts'
    )
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
    // Keep literal population floor independent of debt lengths; derived bound moves with lists and proves nothing.
    expect(
      gatedFiles.length,
      `Found ${gatedFiles.length} Windows-gated test files; the floor is ${GATED_FILE_FLOOR}. ` +
        'A drop means the scan stopped matching, not that the files went away. Lower the floor ' +
        'only for a genuine deletion.'
    ).toBeGreaterThanOrEqual(GATED_FILE_FLOOR)
  })

  it('confirms the classifier distinguishes registered from unregistered paths', () => {
    // Reject classifier answering true for all paths or registration assertions become vacuous.
    expect(isInClassifier('src/main/windows/windows-pty-job.win32.test.ts')).toBe(true)
    expect(isInClassifier('src/main/windows/not-a-real-file.win32.test.ts')).toBe(false)
  })

  it('has every Windows-gated test file registered in the Windows lane', () => {
    const grandfathered = new Set([...UNREGISTERED_ON_MAIN, ...MANUAL_OPT_IN])
    const failures = gatedFiles
      .filter((path) => !grandfathered.has(path))
      .map(registrationFailure)
      .filter((failure) => failure !== null)
    expect(
      failures,
      'A Windows-gated test file is not registered in the Windows CI lane. It self-skips on ' +
        'ubuntu and reports success, so it runs on no machine. Fix each line below.'
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
        'Register it in WINDOWS_BOUNDARY_TESTS and delete the line.'
    ).toEqual([])
  })

  it('keeps every UNREGISTERED_ON_MAIN file ineligible for MANUAL_OPT_IN', () => {
    // Registrable debt cannot move to manual list just to lower cap.
    const movable = UNREGISTERED_ON_MAIN.filter((path) => requiresEnvOptIn(sourceOf(path)))
    expect(
      movable,
      'This file is registrable; it cannot be reclassified as MANUAL_OPT_IN.'
    ).toEqual([])
  })
})

describe('manual opt-in classification', () => {
  it('requires the env read to reach the gate', () => {
    // Unrelated env use must not exempt CI-satisfiable compound gate (native-addon-bytes shape).
    expect(
      requiresEnvOptIn(
        "const tmp = process.env.RUNNER_TEMP\ndescribe.runIf(process.platform === 'win32' && hasAddon)('x', () => {})"
      )
    ).toBe(false)
    // One const hop matches real manual opt-in gates.
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
    // Bare win32 gate stays registrable despite unrelated env reads.
    expect(
      requiresEnvOptIn(
        "const t = process.env.CI\ndescribe.runIf(process.platform === 'win32')('x', () => {})"
      )
    ).toBe(false)
    // Require && before env conjunct; same-line env read after bare gate must not reopen manual-parking hole.
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
  // Pair actual gate shapes with near misses so fixtures test repository semantics rather than echo regex.
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
    // Falsy-on-win32 flag with && also runs POSIX when second term is false; preserve literal/alias equivalence instead of widening to Windows-only.
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
