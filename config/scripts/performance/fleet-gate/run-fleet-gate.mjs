#!/usr/bin/env node
// Fleet-scale perf gate: OLD vs NEW on a ~1,900-workspace profile clone. Usage: docs/readme/fleet-perf-gate.md.
import { _electron as electron } from '@stablyai/playwright-test'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { buildCounterbalancedSchedule } from '../measurement/counterbalanced-benchmark-schedule.mjs'
import { hotPathChanges } from './fleet-gate-hot-paths.mjs'
import { installMainProbeIn, resetMainProbe, snapshotMainProbe } from './fleet-gate-main-probe.mjs'
import { installRendererProbe } from './fleet-gate-renderer-probe.mjs'
import { compareRuns, formatTable, windowMetrics } from './fleet-gate-report.mjs'
import { SCENARIOS } from './fleet-gate-scenarios.mjs'
import {
  assertFleetSeed,
  cloneFleetSeed,
  describeFleetSeed,
  prepareFleetSeed
} from './fleet-gate-seed.mjs'

const CACHE_ROOT =
  process.env.ORCA_FLEET_GATE_CACHE ?? path.join(os.homedir(), '.cache', 'orca-fleet-gate')
const KEEP_BUILDS = 4

function parseArgs(argv) {
  const options = {
    old: null,
    new: 'HEAD',
    seed: process.env.ORCA_FLEET_SEED_DIR ?? path.join(CACHE_ROOT, 'seed'),
    prepareSeed: null,
    runs: 2,
    settleMs: 120_000,
    windowMs: 30_000,
    idleWindowMs: 60_000,
    scenarios: Object.keys(SCENARIOS),
    force: false,
    pathsOnly: false,
    out: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      index += 1
      if (argv[index] === undefined) {
        throw new Error(`${arg} needs a value`)
      }
      return argv[index]
    }
    const setters = {
      '--old': () => (options.old = value()),
      '--new': () => (options.new = value()),
      '--seed': () => (options.seed = path.resolve(value())),
      '--prepare-seed': () => (options.prepareSeed = path.resolve(value())),
      '--runs': () => (options.runs = Number(value())),
      '--settle-ms': () => (options.settleMs = Number(value())),
      '--window-ms': () => (options.windowMs = Number(value())),
      '--idle-window-ms': () => (options.idleWindowMs = Number(value())),
      '--scenarios': () => (options.scenarios = value().split(',').filter(Boolean)),
      '--out': () => (options.out = path.resolve(value())),
      '--force': () => (options.force = true),
      '--paths-only': () => (options.pathsOnly = true),
      '--': () => {}
    }
    if (!setters[arg]) {
      throw new Error(`unknown argument ${arg}`)
    }
    setters[arg]()
  }
  for (const name of options.scenarios) {
    if (!SCENARIOS[name]) {
      throw new Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(', ')}`)
    }
  }
  return options
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function run(command, args, cwd, logFile) {
  const fd = fs.openSync(logFile, 'a')
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', fd, fd], env: process.env })
  fs.closeSync(fd)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd} (log ${logFile})`)
  }
}

/** One e2e-mode build per commit, cached; a --shared clone, so nothing registers as a worktree of the checkout. */
function ensureBuild(repoRoot, sha) {
  const buildsDir = path.join(CACHE_ROOT, 'builds')
  const dir = path.join(buildsDir, sha)
  const marker = path.join(dir, '.fleet-gate-built')
  if (fs.existsSync(marker)) {
    fs.utimesSync(marker, new Date(), new Date())
    return dir
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(buildsDir, { recursive: true })
  const log = path.join(buildsDir, `${sha}.log`)
  fs.writeFileSync(log, '')
  console.log(`[fleet-gate] building ${sha.slice(0, 12)} (log ${log})`)
  run('git', ['clone', '--quiet', '--shared', '--no-checkout', repoRoot, dir], buildsDir, log)
  run('git', ['checkout', '--quiet', '--detach', sha], dir, log)
  run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], dir, log)
  run('pnpm', ['run', 'build:packages'], dir, log)
  run(
    process.execPath,
    ['config/scripts/desktop-build/execution/run-electron-vite-build.mjs', '--mode', 'e2e'],
    dir,
    log
  )
  run('pnpm', ['run', 'ensure:electron-runtime'], dir, log)
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
  pruneBuilds(buildsDir, new Set([dir]))
  return dir
}

function pruneBuilds(buildsDir, keep) {
  const builds = fs
    .readdirSync(buildsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(buildsDir, entry.name))
    .map((dir) => ({
      dir,
      mtime:
        fs.statSync(path.join(dir, '.fleet-gate-built'), { throwIfNoEntry: false })?.mtimeMs ?? 0
    }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { dir } of builds.slice(KEEP_BUILDS)) {
    if (!keep.has(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

function launchArgs(buildDir) {
  const keychain = ['--password-store=basic', '--use-mock-keychain']
  if (process.platform !== 'linux') {
    return [...keychain, buildDir]
  }
  const display =
    process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? [] : ['--ozone-platform=headless']
  return [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--in-process-gpu',
    ...display,
    ...keychain,
    buildDir
  ]
}

function isolatedEnv(runDir, userDataDir) {
  const home = path.join(runDir, 'home')
  for (const dir of [
    '',
    '.config',
    '.cache',
    '.local/share',
    '.local/state',
    '.claude',
    '.codex'
  ]) {
    fs.mkdirSync(path.join(home, dir), { recursive: true })
  }
  // Drop the launching Orca's own values so the copy never attaches to it.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('ORCA_') && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'NODE_OPTIONS'
    )
  )
  return {
    ...env,
    NODE_ENV: 'development',
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_E2E_HEADLESS: '1',
    ORCA_E2E_USER_DATA_DIR: userDataDir,
    ORCA_E2E_HOME_DIR: home,
    ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex')
  }
}

async function measureOnce({ arm, sha, buildDir, options, runDir }) {
  const userDataDir = path.join(runDir, 'user-data')
  cloneFleetSeed(options.seed, userDataDir)
  const executablePath = createRequire(path.join(buildDir, 'package.json'))('electron')
  const app = await electron.launch({
    executablePath,
    args: launchArgs(buildDir),
    env: isolatedEnv(runDir, userDataDir),
    timeout: 180_000
  })
  const result = { arm, sha, windows: {}, census: null, notes: [] }
  try {
    const page = await app.firstWindow({ timeout: 180_000 })
    await page.waitForFunction(
      () => window.__store?.getState().workspaceSessionReady === true,
      null,
      {
        timeout: 300_000
      }
    )
    const probeState = await installMainProbeIn(app)
    if (probeState !== 'installed') {
      result.notes.push(`main probe ${probeState}: R→M counts only send(), not invoke()`)
    }
    const renderer = await installRendererProbe(page)
    if (renderer.breakpoints === 0) {
      result.notes.push('store notify loop not found: store pubs/wakeups not measured')
    }
    console.log(`[fleet-gate] ${arm} ${sha.slice(0, 12)} up; settling ${options.settleMs / 1000}s`)
    await new Promise((resolve) => setTimeout(resolve, options.settleMs))
    result.census = await page.evaluate(() => {
      const state = window.__store.getState()
      return {
        workspaces: Object.values(state.worktreesByRepo).flat().length,
        tabBuckets: Object.keys(state.unifiedTabsByWorktree ?? {}).length,
        terminalTabs: Object.values(state.tabsByWorktree ?? {}).flat().length,
        agentStatuses: Object.keys(state.agentStatusByPaneKey ?? {}).length
      }
    })
    for (const name of options.scenarios) {
      const windowMs = name === 'idle' ? options.idleWindowMs : options.windowMs
      await resetMainProbe(app)
      await renderer.reset()
      const started = Date.now()
      const driven = await SCENARIOS[name]({ page, userDataDir, windowMs })
      const elapsed = Date.now() - started
      const main = await snapshotMainProbe(app)
      const rendererSnapshot = await renderer.snapshot()
      result.windows[name] = {
        driven,
        elapsedMs: elapsed,
        metrics: windowMetrics(
          main,
          renderer.breakpoints > 0
            ? rendererSnapshot
            : { ...rendererSnapshot, pubs: Number.NaN, noop: Number.NaN, wakeups: Number.NaN },
          elapsed
        ),
        topOut: Object.entries(main.outByChannel)
          .slice(0, 3)
          .map(([channel, row]) => `${channel} ${row.n} (${row.noop} no-op)`),
        topIn: Object.entries(main.inByChannel)
          .slice(0, 3)
          .map(([channel, row]) => `${channel} ${row.n}`)
      }
      console.log(
        `[fleet-gate] ${arm} ${name}: ${JSON.stringify(result.windows[name].metrics)} ${driven.note ?? ''}`
      )
    }
  } finally {
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 30_000))
    ])
    const child = app.process()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    fs.rmSync(runDir, { recursive: true, force: true })
  }
  return result
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  if (options.prepareSeed) {
    const prepared = await prepareFleetSeed(options.prepareSeed, options.seed)
    console.log(
      `[fleet-gate] seed ready at ${prepared.seedDir}; neutralized ${prepared.neutralized.join(', ') || 'nothing'}; ${JSON.stringify(prepared.census)}`
    )
    return
  }
  const newSha = git(repoRoot, ['rev-parse', `${options.new}^{commit}`])
  const oldSha = git(repoRoot, [
    'rev-parse',
    options.old ? `${options.old}^{commit}` : git(repoRoot, ['merge-base', 'origin/main', newSha])
  ])
  const hot = hotPathChanges(oldSha, newSha, repoRoot)
  if (hot.length === 0 && !options.force) {
    console.log('skipped: no hot-path changes')
    return
  }
  if (options.pathsOnly) {
    console.log(`hot-path changes (${hot.length}): ${hot.slice(0, 10).join(', ')}`)
    return
  }
  assertFleetSeed(options.seed)
  const seedCensus = await describeFleetSeed(options.seed)
  const builds = { old: ensureBuild(repoRoot, oldSha), new: ensureBuild(repoRoot, newSha) }
  const shas = { old: oldSha, new: newSha }
  const runs = []
  const schedule = buildCounterbalancedSchedule(options.runs, 'old', 'new')
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-fleet-gate-'))
  try {
    for (const pair of schedule) {
      for (const arm of pair) {
        runs.push(
          await measureOnce({
            arm,
            sha: shas[arm],
            buildDir: builds[arm],
            options,
            runDir: path.join(runsRoot, `${arm}-${runs.length}`)
          })
        )
      }
    }
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true })
  }
  const census = runs.find((entry) => entry.census)?.census
  const rows = compareRuns(runs, options.scenarios)
  const notes = [...new Set(runs.flatMap((entry) => entry.notes))]
  for (const name of options.scenarios) {
    const drivenNotes = [
      ...new Set(runs.map((entry) => entry.windows[name]?.driven?.note).filter(Boolean))
    ]
    notes.push(`${name}: ${drivenNotes.join(' / ')}`)
  }
  const header = [
    `FLEET GATE  OLD ${oldSha.slice(0, 11)}  NEW ${newSha.slice(0, 11)}  ${options.runs} runs each (alternating)  ${os.hostname()} ${process.platform}`,
    `census: ${census ? `${census.workspaces} workspaces, ${census.tabBuckets} tab buckets, ${census.terminalTabs} terminal tabs, ${census.agentStatuses} agent statuses` : 'n/a'}; seed ${seedCensus.chatRecords} chat records, ${seedCensus.chatTabs} chat tabs`,
    `hot-path files: ${hot.length}${options.force && hot.length === 0 ? ' (forced)' : ''}`
  ].join('\n')
  const { text, passed } = formatTable({ rows, header, notes })
  const outDir = options.out ?? path.join(CACHE_ROOT, 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  const stem = path.join(
    outDir,
    `fleet-gate-${oldSha.slice(0, 11)}-${newSha.slice(0, 11)}-${Date.now()}`
  )
  fs.writeFileSync(
    `${stem}.json`,
    `${JSON.stringify({ oldSha, newSha, hot, census, runs, rows }, null, 2)}\n`
  )
  fs.writeFileSync(`${stem}.txt`, `${text}\n`)
  console.log('=== FLEET GATE TABLE ===')
  console.log(text)
  console.log(`=== END FLEET GATE TABLE === (raw ${stem}.json)`)
  process.exitCode = passed ? 0 : 1
}

main().catch((error) => {
  console.error(`[fleet-gate] ${error.stack ?? error}`)
  process.exitCode = 2
})
