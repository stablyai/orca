#!/usr/bin/env node
// STA-4336 oracle. When macOS Launch Services is unreachable, Electron's main
// aborts inside HIServices `_RegisterApplication` while constructing
// NSApplication — before the V8 isolate exists, so no Orca JavaScript can
// intercept it and a supervisor that retries gets a pre-JS SIGABRT loop.
//
// This harness denies the Launch Services mach services with `sandbox-exec` and
// asserts every CLI entrypoint reuses, refuses, or fails once with a classified
// diagnostic. It is byte-identical across builds: point `--electron`/`--cli` at
// a packaged app, a source build, or a candidate and compare `result.json`.
//
// One measured side effect shapes the harness: each abort leaves Launch Services
// unable to register the next GUI app for ~45s, machine-wide. So the scenarios
// cool down between owners — and a supervisor that retries a failing launch does
// not merely fail repeatedly, it degrades GUI launches for everything else.
//
// Usage:
//   node config/scripts/run-macos-launch-abort-oracle.mjs \
//     --label main --electron <electron-binary> --cli <cli-entry.js> [--app-root <dir>] \
//     [--scenario <name>]... [--out <dir>]
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Why: mirrors SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE. The oracle must run
// against packaged builds with no repo on disk, so it cannot import the source.
export const ALREADY_RUNNING_EXIT_CODE = 3

// Why: the two mach services HIServices needs to register a GUI application.
// `(allow default)` keeps everything else identical to an unsandboxed run, so a
// difference in outcome can only come from Launch Services being unreachable.
export const SANDBOX_PROFILE = `(version 1)
(allow default)
(deny mach-lookup (global-name "com.apple.lsd.mapdb"))
(deny mach-lookup (global-name "com.apple.lsd.modifydb"))
(deny mach-lookup (global-name "com.apple.lsd.openurl"))
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))
`

export const SCENARIOS = [
  'serve-fresh-sandboxed',
  'serve-fresh-open',
  'serve-duplicate-sandboxed',
  'serve-duplicate-open',
  'open-duplicate',
  'recipe-json-duplicate'
]

const DUPLICATE_SCENARIOS = new Set([
  'serve-duplicate-sandboxed',
  'serve-duplicate-open',
  'open-duplicate',
  'recipe-json-duplicate'
])

/**
 * Why: the duplicate scenarios share one owning runtime that must be started
 * before anything has aborted, so they run first regardless of the order the
 * caller named them in.
 */
export function orderedScenarios(scenarios) {
  return [
    ...scenarios.filter((scenario) => DUPLICATE_SCENARIOS.has(scenario)),
    ...scenarios.filter((scenario) => !DUPLICATE_SCENARIOS.has(scenario))
  ]
}

// Why: failure deadlines, never success conditions. Every scenario that passes
// resolves in well under a second; these only stop a hang from running forever.
const ATTEMPT_TIMEOUT_MS = 45_000
const OWNER_READY_TIMEOUT_MS = 45_000
// Why: a healthy owner publishes its metadata in ~3s. But a `_RegisterApplication`
// abort leaves Launch Services unable to register the *next* GUI app for roughly
// half a minute, so a scenario that follows one stalls before `ready` through no
// fault of the build under test. Measured on macOS 25.5: wedged immediately after
// an abort, clear again after ~45s. Retry past it rather than grading noise —
// and note that this is itself why a crash-looping supervisor makes things worse.
// The cooldown must exceed the ~45s wedge, and the wedge restarts when the
// stalled owner is killed, so a shorter wait retries straight back into it.
const OWNER_START_ATTEMPTS = 3
const OWNER_RETRY_COOLDOWN_MS = 60_000
const FAST_FAILURE_BUDGET_MS = 5_000
const CRASH_REPORT_FLUSH_MS = 3_000
const GRACEFUL_SHUTDOWN_MS = 15_000

/**
 * @typedef {{
 *   scenarios: string[]
 *   label: string
 *   electron?: string
 *   cli?: string
 *   appRoot: string | null
 *   out: string | null
 * }} OracleArgs
 */

/** @param {string[]} argv @returns {OracleArgs} */
export function parseArgs(argv) {
  /** @type {OracleArgs} */
  const args = { scenarios: [], label: 'candidate', appRoot: null, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    // Why: a flag whose value is missing must not silently become `undefined` —
    // it would run the wrong build under the wrong label and look like evidence.
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} requires a value`)
      }
      return next
    }
    switch (flag) {
      case '--label':
        args.label = value()
        index += 1
        break
      case '--electron':
        args.electron = value()
        index += 1
        break
      case '--cli':
        args.cli = value()
        index += 1
        break
      case '--app-root':
        args.appRoot = value()
        index += 1
        break
      case '--out':
        args.out = value()
        index += 1
        break
      case '--scenario':
        args.scenarios.push(value())
        index += 1
        break
      default:
        throw new Error(`unknown argument: ${String(flag)}`)
    }
  }
  if (!args.electron || !args.cli) {
    throw new Error('--electron and --cli are required')
  }
  const unknown = args.scenarios.filter((scenario) => !SCENARIOS.includes(scenario))
  if (unknown.length > 0) {
    throw new Error(`unknown scenario(s): ${unknown.join(', ')}`)
  }
  if (args.scenarios.length === 0) {
    args.scenarios = [...SCENARIOS]
  }
  return args
}

/**
 * The pass/fail rule, kept separate from execution so it can be unit tested and
 * so a reader can see the invariant without reading the process plumbing.
 */
// Why: the invariant is not "never abort" — with no desktop login there is
// genuinely no way to start a GUI Electron main. It is that the abort is
// converted into one classified, actionable, non-retryable failure.
function carriesLaunchAbortDiagnostic(result) {
  const output = `${result.attemptStderr}${result.attemptStdout}`
  return output.includes('_RegisterApplication') && output.includes('Retrying cannot help')
}

export function judge(result) {
  const failures = []
  const classified = carriesLaunchAbortDiagnostic(result)
  if (DUPLICATE_SCENARIOS.has(result.scenario)) {
    if (result.ownerReady !== true) {
      // Why: report the scenario as ungraded rather than stacking downstream
      // verdicts on a run that never had a profile owner to duplicate.
      return ['the owning runtime never became ready, so nothing was tested']
    }
    // A profile that already has an owner must be reused or refused. Reaching
    // the unsafe NSApplication boundary at all is the defect.
    if (result.attemptReportedSigabrt || result.crashStackHasRegisterApplication) {
      failures.push('a second Electron main was launched against an owned profile and aborted')
    }
  } else if (result.attemptReportedSigabrt && !classified) {
    failures.push('the attempt died on a bare SIGABRT with no classified diagnostic')
  }
  if (
    result.scenario === 'serve-duplicate-sandboxed' ||
    result.scenario === 'serve-duplicate-open' ||
    result.scenario === 'recipe-json-duplicate'
  ) {
    if (result.attemptExitCode !== ALREADY_RUNNING_EXIT_CODE) {
      failures.push(
        `expected exit ${ALREADY_RUNNING_EXIT_CODE}, got ${String(result.attemptExitCode)}`
      )
    }
  }
  if (result.scenario === 'open-duplicate') {
    // Why: the defect made `orca open` sit out its full window timeout and then
    // blame a missing window, which reads as a hang and invites a retry.
    if (result.attemptDurationMs > FAST_FAILURE_BUDGET_MS) {
      failures.push(`took ${result.attemptDurationMs}ms; a classified refusal must be prompt`)
    }
    if (result.attemptExitCode === 0) {
      failures.push('open reported success without a desktop window')
    }
    const output = `${result.attemptStderr}${result.attemptStdout}`
    if (!/runtime_open_failed|desktop_activation_blocked|_RegisterApplication/.test(output)) {
      failures.push('the refusal carried no machine-readable cause')
    }
  }
  if (result.scenario === 'serve-fresh-sandboxed') {
    if (result.attemptExitCode === 0) {
      failures.push('a serve that cannot register with Launch Services must not report success')
    }
    if (!classified) {
      failures.push('the single failure did not carry an actionable diagnostic')
    }
  }
  if (result.scenario === 'serve-fresh-open' && !result.childOrcaJsRan) {
    failures.push('an unsandboxed fresh serve never reached Orca JavaScript')
  }
  return failures
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function listCrashReports(reportsDir) {
  try {
    return (await fs.readdir(reportsDir)).sort()
  } catch {
    return []
  }
}

/**
 * @param settled Optional predicate polled while the child runs. A long-lived
 *   scenario (a serve that is *supposed* to keep running) is asked to stop as
 *   soon as it has proven what the scenario measures, so the harness never has
 *   to SIGKILL a healthy GUI Electron main.
 */
async function runBounded(command, args, options, timeoutMs, settled = null) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    let checking = false
    const poll = settled
      ? setInterval(() => {
          if (checking) {
            return
          }
          checking = true
          void settled().then(
            (done) => {
              checking = false
              if (done) {
                child.kill('SIGTERM')
              }
            },
            () => {
              checking = false
            }
          )
        }, 250)
      : null
    const stopPolling = () => {
      if (poll) {
        clearInterval(poll)
      }
    }
    child.once('error', (error) => {
      clearTimeout(timer)
      stopPolling()
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: `${stderr}${error.message}: ${command} ${args.join(' ')}`
      })
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      stopPolling()
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/**
 * A live headless Orca that owns the shared profile. Started by direct bundle
 * exec, so userData isolation is enforced by the app itself rather than by the
 * CLI path under test.
 */
async function startOwner(session) {
  const child = spawn(
    session.electron,
    [
      ...(session.appRoot ? [session.appRoot] : []),
      `--user-data-dir=${session.ownerProfile}`,
      '--serve',
      '--serve-port',
      String(session.ownerPort),
      '--serve-no-pairing'
    ],
    {
      stdio: ['ignore', session.ownerLog.fd, session.ownerLog.fd],
      env: {
        ...session.baseEnv,
        ORCA_DEV_USER_DATA_PATH: session.ownerProfile,
        ORCA_STARTUP_DIAGNOSTICS: '1',
        ORCA_STARTUP_DIAGNOSTICS_FILE: path.join(
          session.outDir,
          `${session.label}-owner-startup.log`
        )
      }
    }
  )
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  const metadataPath = path.join(session.ownerProfile, 'orca-runtime.json')
  const deadline = nowMs() + OWNER_READY_TIMEOUT_MS
  while (nowMs() < deadline) {
    if (
      await fs.stat(metadataPath).then(
        () => true,
        () => false
      )
    ) {
      return child
    }
    if (exited) {
      return null
    }
    await sleep(500)
  }
  return null
}

/**
 * Why: every abort wedges the next GUI app launch for ~45s, so the owning
 * runtime is started once, before any scenario has run, and shared by the
 * duplicate scenarios. Starting one per scenario put each owner launch directly
 * behind the previous scenario's abort, which stalls and grades as noise.
 */
async function startSharedOwner(session) {
  await fs.rm(session.ownerProfile, { recursive: true, force: true })
  await fs.mkdir(session.ownerProfile, { recursive: true })
  session.ownerLog = await fs.open(path.join(session.outDir, `${session.label}-owner.log`), 'a')
  while (session.owner === null && session.ownerAttempts < OWNER_START_ATTEMPTS) {
    session.ownerAttempts += 1
    session.owner = await startOwner(session)
    if (session.owner === null) {
      await killTree(session.ownerProfile)
      if (session.ownerAttempts < OWNER_START_ATTEMPTS) {
        console.log('     … owner stalled before ready; waiting out Launch Services')
        await sleep(OWNER_RETRY_COOLDOWN_MS)
      }
    }
  }
  session.ownerReady = session.owner !== null
}

/**
 * Why: the CLI spawns `ORCA_APP_EXECUTABLE` with no profile switch, and only
 * `ORCA_DEV_USER_DATA_PATH` redirects userData — which a *packaged* main ignores.
 * Without this, the packaged arm would start Electron on the real user profile.
 * The wrapper pins `--user-data-dir` for every arm so the arms stay comparable,
 * and sits at a `<name>.app/Contents/MacOS/` path so the CLI's bundle-shape
 * checks (serve-update handoff) take the same branch a real bundle would.
 */
/** A quote in a path would otherwise close the quoting and run the rest as shell. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

export function executableWrapperScript(electron, profile) {
  return `#!/bin/sh\nexec ${shellQuote(electron)} ${shellQuote(`--user-data-dir=${profile}`)} "$@"\n`
}

async function writeExecutableWrapper(context) {
  const macOsDir = path.join(context.runDir, 'Orca.app', 'Contents', 'MacOS')
  await fs.mkdir(macOsDir, { recursive: true })
  const wrapper = path.join(macOsDir, 'Orca')
  await fs.writeFile(wrapper, executableWrapperScript(context.electron, context.profile), {
    mode: 0o755
  })
  return wrapper
}

function cliEnv(context, extra = {}) {
  return {
    ...context.baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
    ORCA_USER_DATA_PATH: context.profile,
    ORCA_DEV_USER_DATA_PATH: context.profile,
    ORCA_APP_EXECUTABLE: context.executable,
    ORCA_APP_EXECUTABLE_NEEDS_APP_ROOT: context.appRoot ? '1' : '0',
    ORCA_STARTUP_DIAGNOSTICS: '1',
    ORCA_STARTUP_DIAGNOSTICS_FILE: path.join(context.runDir, 'child-startup.log'),
    ...extra
  }
}

function attemptCommand(context, scenario) {
  const cli = [context.electron, context.cli]
  const serve = ['serve', '--port', String(context.duplicatePort), '--no-pairing']
  const sandboxed = (argv) => ({
    command: 'sandbox-exec',
    args: ['-f', context.sandboxProfilePath, ...cli, ...argv]
  })
  switch (scenario) {
    case 'serve-fresh-sandboxed':
    case 'serve-duplicate-sandboxed':
      return sandboxed(serve)
    case 'open-duplicate':
      return sandboxed(['open', '--json'])
    case 'recipe-json-duplicate':
      return sandboxed(['serve', '--recipe-json', '--project-root', context.runDir])
    case 'serve-fresh-open':
    case 'serve-duplicate-open':
      return { command: cli[0], args: [cli[1], ...serve] }
    default:
      throw new Error(`unknown scenario: ${scenario}`)
  }
}

/** Proof that the launched Electron main reached Orca JavaScript. */
async function childStartupObserved(runDir) {
  return await fs.stat(path.join(runDir, 'child-startup.log')).then(
    (stat) => stat.size > 0,
    () => false
  )
}

async function pidsHoldingProfile(profile) {
  // Why: only the owner carries `--user-data-dir` in argv; an Electron main the
  // CLI spawned knows its profile through the environment alone and reparents to
  // launchd when the CLI exits. Matching argv only leaves that GUI app running,
  // and a live stale registration wedges the next scenario's launch before
  // `ready`. `-E` puts the environment in the listing so both are matched.
  const listing = await runBounded('/bin/ps', ['-eEww', '-o', 'pid=,command='], {}, 10_000)
  return listing.stdout
    .split('\n')
    .filter((line) => line.includes(profile))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid)
}

async function killTree(profile) {
  // Why: the spawned Electron main reparents to launchd when its CLI parent
  // dies, so cleanup keys off the run's own isolated profile path and never
  // signals a process this run did not create.
  const signal = (pids, name) => {
    for (const pid of pids) {
      try {
        process.kill(pid, name)
      } catch {
        // already gone
      }
    }
  }
  signal(await pidsHoldingProfile(profile), 'SIGTERM')
  // Why: SIGKILLing a GUI Electron main mid-shutdown leaves macOS Launch
  // Services holding a stale registration, and the *next* scenario's app then
  // stalls before `ready` — a harness failure that reads as a real defect.
  const deadline = nowMs() + GRACEFUL_SHUTDOWN_MS
  while (nowMs() < deadline) {
    if ((await pidsHoldingProfile(profile)).length === 0) {
      return
    }
    await sleep(500)
  }
  signal(await pidsHoldingProfile(profile), 'SIGKILL')
  await sleep(500)
}

// Why: macOS caps unix socket paths at 104 bytes and the terminal daemon builds
// its socket under userData. `os.tmpdir()` is a long per-user path, so profiles
// live under /tmp or the daemon fails to listen with EINVAL and the owning
// runtime never publishes its metadata.
function profilePath(key) {
  return path.join(
    '/tmp',
    'orca-launch-abort-oracle',
    createHash('md5').update(key).digest('hex').slice(0, 10)
  )
}

async function runScenario(session, scenario) {
  const isDuplicate = DUPLICATE_SCENARIOS.has(scenario)
  const runDir = path.join(session.outDir, `${session.label}-${scenario}`)
  await fs.rm(runDir, { recursive: true, force: true })
  await fs.mkdir(runDir, { recursive: true })
  const profile = isDuplicate ? session.ownerProfile : profilePath(`${session.label}-${scenario}`)
  if (!isDuplicate) {
    await fs.rm(profile, { recursive: true, force: true })
    await fs.mkdir(profile, { recursive: true })
  }

  const context = { ...session, profile, runDir }
  context.executable = await writeExecutableWrapper(context)
  const reportsDir = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports')
  try {
    const ownerReady = isDuplicate ? session.ownerReady : null
    const ownerAttempts = isDuplicate ? session.ownerAttempts : 0
    const before = await listCrashReports(reportsDir)
    const startedAt = nowMs()
    const { command, args: attemptArgs } = attemptCommand(context, scenario)
    const attempt = await runBounded(
      command,
      attemptArgs,
      { env: cliEnv(context) },
      ATTEMPT_TIMEOUT_MS,
      // Why: a fresh unsandboxed serve is *supposed* to keep running, so the
      // scenario ends the moment it has proven Orca JavaScript ran rather than
      // sitting out the timeout and being killed hard.
      scenario === 'serve-fresh-open' ? () => childStartupObserved(runDir) : null
    )
    const attemptDurationMs = nowMs() - startedAt
    // Why: ReportCrash flushes lazily, so `.ips` evidence corroborates the
    // in-band signals below and is never the primary one.
    await new Promise((resolve) => setTimeout(resolve, CRASH_REPORT_FLUSH_MS))
    const added = (await listCrashReports(reportsDir)).filter((name) => !before.includes(name))
    let registerApplication = false
    for (const name of added) {
      const body = await fs.readFile(path.join(reportsDir, name), 'utf8').catch(() => '')
      if (body.includes('_RegisterApplication')) {
        registerApplication = true
      }
    }
    const result = {
      label: session.label,
      scenario,
      attemptExitCode: attempt.code,
      attemptSignal: attempt.signal,
      ownerReady,
      ownerAttempts,
      newCrashReports: added,
      crashStackHasRegisterApplication: registerApplication,
      childOrcaJsRan: await childStartupObserved(runDir),
      runtimeMetadataAfter: await fs.stat(path.join(profile, 'orca-runtime.json')).then(
        () => true,
        () => false
      ),
      attemptReportedSigabrt: /SIGABRT/.test(attempt.stderr),
      attemptDurationMs,
      attemptStdout: attempt.stdout.slice(-4000),
      attemptStderr: attempt.stderr.slice(-4000)
    }
    result.failures = judge(result)
    await fs.writeFile(path.join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    return result
  } finally {
    // Why: the shared owner outlives the scenario; only a fresh scenario's own
    // processes are cleaned up here.
    if (!isDuplicate) {
      await killTree(profile)
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'darwin') {
    console.error('This oracle depends on macOS Launch Services and sandbox-exec.')
    return 1
  }
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 64
  }
  const outDir = args.out ?? path.join(os.tmpdir(), 'orca-launch-abort-oracle-runs')
  await fs.mkdir(outDir, { recursive: true })
  const sandboxProfilePath = path.join(outDir, 'deny-launch-services.sb')
  await fs.writeFile(sandboxProfilePath, SANDBOX_PROFILE)

  const session = {
    electron: args.electron,
    cli: args.cli,
    appRoot: args.appRoot,
    label: args.label,
    outDir,
    sandboxProfilePath,
    ownerProfile: profilePath(`${args.label}-owner`),
    ownerPort: 21_000 + Math.floor(Math.random() * 2000),
    duplicatePort: 23_000 + Math.floor(Math.random() * 2000),
    ownerLog: null,
    owner: null,
    ownerReady: null,
    ownerAttempts: 0,
    baseEnv: { ...process.env, ORCA_USER_DATA_PATH: undefined }
  }
  const scenarios = orderedScenarios(args.scenarios)

  const results = []
  try {
    if (scenarios.some((scenario) => DUPLICATE_SCENARIOS.has(scenario))) {
      await startSharedOwner(session)
    }
    for (const scenario of scenarios) {
      const result = await runScenario(session, scenario)
      results.push(result)
      const verdict = result.failures.length === 0 ? 'PASS' : 'FAIL'
      const summary = [
        `exit=${String(result.attemptExitCode)}`,
        `signal=${String(result.attemptSignal)}`,
        `sigabrt=${String(result.attemptReportedSigabrt)}`,
        `owner=${String(result.ownerReady)}`,
        `childJs=${String(result.childOrcaJsRan)}`,
        `${result.attemptDurationMs}ms`
      ].join(' ')
      console.log(`${verdict} ${args.label} ${scenario}: ${summary}`)
      for (const failure of result.failures) {
        console.log(`     - ${failure}`)
      }
    }
  } finally {
    session.owner?.kill('SIGTERM')
    await session.ownerLog?.close()
    await killTree(session.ownerProfile)
  }
  console.log(`\nEvidence: ${outDir}`)
  return results.some((result) => result.failures.length > 0) ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main())
}
