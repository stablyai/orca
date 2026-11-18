#!/usr/bin/env node
// Fleet-scale perf gate: OLD vs NEW on a ~1,900-workspace synthetic profile. Usage: docs/readme/fleet-perf-gate.md.
import { _electron as electron } from '@stablyai/playwright-test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { buildCounterbalancedSchedule } from '../measurement/counterbalanced-benchmark-schedule.mjs'
import { CACHE_ROOT, ensureBuild, git, pruneCache, resolveCommit } from './fleet-gate-builds.mjs'
import { hotPathChanges } from './fleet-gate-hot-paths.mjs'
import { installMainProbeIn, resetMainProbe, snapshotMainProbe } from './fleet-gate-main-probe.mjs'
import { installRendererProbe } from './fleet-gate-renderer-probe.mjs'
import { burstRows, compareRuns, formatTable, windowMetrics } from './fleet-gate-report.mjs'
import {
  BURST_CHATS,
  continueAfterRestart,
  countLaunches,
  countOwnershipRefusals,
  createChatBurst,
  startCpuLoad,
  pointClaudeAtStub,
  waitForLaunches,
  writeClaudeStub
} from './fleet-gate-launch-burst.mjs'
import { SCENARIOS, seedAgentStatuses } from './fleet-gate-scenarios.mjs'
import {
  buildSyntheticFleetSeed,
  readFleetCensus,
  readSeedReceipt,
  SEED_SHAPE
} from './fleet-gate-synthetic-seed.mjs'

const KEEP_SEEDS = 2
// Idle agents spread over this many workspaces; the #42104 report had ~500 keyed statuses on ~1,900 workspaces.
const AGENT_PANES = 200
// Only Linux gets a private display; elsewhere copies stay hidden and unpainted, so clicks and focus can't be driven.
const PAINTED = process.platform === 'linux'
const DEFAULT_SCENARIOS = PAINTED
  ? [...Object.keys(SCENARIOS), 'burst']
  : ['idle', 'streaming', 'burst']

// Packaged builds don't expose the store the gate seeds, drives and probes through.
function packagedAppUnsupported() {
  throw new Error(
    'packaged apps are not supported: pass the release tags (--old v1.4.262 --new <candidate>); the gate rebuilds them from source in e2e mode'
  )
}

function parseArgs(argv) {
  const options = {
    old: null,
    new: 'HEAD',
    seed: process.env.ORCA_FLEET_SEED_DIR ?? null,
    runs: 2,
    settleMs: 120_000,
    windowMs: 30_000,
    idleWindowMs: 60_000,
    scenarios: DEFAULT_SCENARIOS,
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
      '--runs': () => (options.runs = Number(value())),
      '--settle-ms': () => (options.settleMs = Number(value())),
      '--window-ms': () => (options.windowMs = Number(value())),
      '--idle-window-ms': () => (options.idleWindowMs = Number(value())),
      '--scenarios': () => (options.scenarios = value().split(',').filter(Boolean)),
      '--out': () => (options.out = path.resolve(value())),
      '--force': () => (options.force = true),
      '--paths-only': () => (options.pathsOnly = true),
      '--old-app': packagedAppUnsupported,
      '--new-app': packagedAppUnsupported,
      '--': () => {}
    }
    if (!setters[arg]) {
      throw new Error(`unknown argument ${arg}`)
    }
    setters[arg]()
  }
  for (const name of options.scenarios) {
    if (!SCENARIOS[name] && name !== 'burst') {
      throw new Error(`unknown scenario ${name}; known: ${Object.keys(SCENARIOS).join(', ')}`)
    }
  }
  return options
}

// Hidden windows never paint, so clicks and screenshots stall; on Linux the copy gets its own Xvfb, never a real desktop.
let virtualDisplay = null

function findOnPath(binary) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, binary)
    if (dir && fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

async function startVirtualDisplay() {
  const xvfb = process.platform === 'linux' ? findOnPath('Xvfb') : null
  if (!xvfb) {
    return null
  }
  let number = 140 + Math.floor(Math.random() * 400)
  while (fs.existsSync(`/tmp/.X11-unix/X${number}`) || fs.existsSync(`/tmp/.X${number}-lock`)) {
    number += 1
  }
  const child = spawn(xvfb, [`:${number}`, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], {
    stdio: 'ignore'
  })
  const deadline = Date.now() + 10_000
  while (!fs.existsSync(`/tmp/.X11-unix/X${number}`)) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill('SIGKILL')
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { display: `:${number}`, stop: () => child.kill('SIGTERM') }
}

function launchArgs(buildDir) {
  const keychain = ['--password-store=basic', '--use-mock-keychain']
  if (process.platform !== 'linux') {
    return [...keychain, buildDir]
  }
  // Pin X11 on Xvfb: Electron otherwise follows the session's Wayland hints and fails without a compositor.
  const display = virtualDisplay ? ['--ozone-platform=x11'] : ['--ozone-platform=headless']
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
        !key.startsWith('ORCA_') &&
        ![
          'ELECTRON_RUN_AS_NODE',
          'NODE_OPTIONS',
          'WAYLAND_DISPLAY',
          'DISPLAY',
          'XDG_SESSION_TYPE',
          'ELECTRON_OZONE_PLATFORM_HINT'
        ].includes(key)
    )
  )
  return {
    ...env,
    ...(virtualDisplay
      ? { DISPLAY: virtualDisplay.display, ORCA_E2E_HEADFUL: '1' }
      : { ORCA_E2E_HEADLESS: '1' }),
    NODE_ENV: 'development',
    ORCA_BACKGROUND_LAUNCH: '1',
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

const READY_TIMEOUT_MS = 300_000

function readWindowState() {
  return {
    url: location.href,
    hasApi: Boolean(window.api),
    hasStore: Boolean(window.__store),
    ready: window.__store?.getState().workspaceSessionReady ?? null,
    text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300)
  }
}

/** The session-ready app window; on timeout, writes what every window showed so one run explains the failure. */
async function waitForAppWindow(app, { label, userDataDir, outDir, stderrTail }) {
  const consoleErrors = []
  const watch = (page) =>
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text().slice(0, 300))
        consoleErrors.splice(0, Math.max(0, consoleErrors.length - 20))
      }
    })
  await app.firstWindow({ timeout: 180_000 })
  app.windows().forEach(watch)
  app.on('window', watch)
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      const ready = await page
        .evaluate(() => window.__store?.getState().workspaceSessionReady === true)
        .catch(() => false)
      if (ready) {
        return page
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  const windows = []
  for (const page of app.windows()) {
    windows.push(await page.evaluate(readWindowState).catch((error) => ({ error: String(error) })))
  }
  fs.mkdirSync(outDir, { recursive: true })
  const stem = path.join(outDir, `not-ready-${label}-${Date.now()}`)
  await app
    .windows()[0]
    ?.screenshot({ path: `${stem}.png` })
    .catch(() => {})
  const userDataFiles = fs.readdirSync(userDataDir).slice(0, 40)
  fs.writeFileSync(
    `${stem}.json`,
    `${JSON.stringify({ windows, consoleErrors, stderrTail, userDataFiles }, null, 2)}\n`
  )
  console.log(`[fleet-gate] ${label} never became ready: ${JSON.stringify(windows).slice(0, 600)}`)
  console.log(
    `[fleet-gate] console errors: ${JSON.stringify(consoleErrors.slice(-5)).slice(0, 600)}`
  )
  console.log(`[fleet-gate] stderr tail: ${JSON.stringify(stderrTail.slice(-8)).slice(0, 800)}`)
  throw new Error(`${label} not session-ready after ${READY_TIMEOUT_MS / 1000}s (${stem}.json)`)
}

/** Launches one hidden copy on userDataDir; close() quits it (gracefully first) and is safe to call twice. */
async function launchCopy({ buildDir, runDir, userDataDir, label, outDir, extraEnv = {} }) {
  const executablePath = createRequire(path.join(buildDir, 'package.json'))('electron')
  const app = await electron.launch({
    executablePath,
    args: launchArgs(buildDir),
    env: { ...isolatedEnv(runDir, userDataDir), ...extraEnv },
    timeout: 180_000
  })
  // Captured now: app.process() throws once the app object is closed.
  const child = app.process()
  const stderrTail = []
  let ownershipText = ''
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    if (/provider process ownership/i.test(text)) {
      ownershipText += text
    }
    stderrTail.push(...text.split('\n').filter(Boolean))
    stderrTail.splice(0, Math.max(0, stderrTail.length - 40))
  })
  let closed = false
  const close = async () => {
    if (closed) {
      return
    }
    closed = true
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 30_000))
    ])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  try {
    const page = await waitForAppWindow(app, { label, userDataDir, outDir, stderrTail })
    return { app, page, close, ownershipText: () => ownershipText }
  } catch (error) {
    await close()
    throw error
  }
}

/** Quit with chats mid-turn, restart under load and continue them all, then a cold burst: every launch must start. */
async function burstOnce({ arm, sha, buildDir, seedDir, runDir, outDir, repoRoot }) {
  const userDataDir = path.join(runDir, 'user-data')
  fs.cpSync(seedDir, userDataDir, { recursive: true, mode: fs.constants.COPYFILE_FICLONE })
  const stub = writeClaudeStub(path.join(runDir, 'stub'), repoRoot)
  const extraEnv = {
    PATH: [path.dirname(stub.command), process.env.PATH ?? ''].join(path.delimiter)
  }
  const label = `burst-${arm}-${sha.slice(0, 11)}`
  const copy = (suffix) =>
    launchCopy({ buildDir, runDir, userDataDir, label: `${label}-${suffix}`, outDir, extraEnv })
  const result = { arm, sha }
  let stderrOwnership = ''
  const first = await copy('mid-turn')
  try {
    await pointClaudeAtStub(first.page, stub.command)
    // The stub keeps a prompt containing "slow" running until interrupted, so these chats quit mid-turn.
    result.midTurn = await createChatBurst(first.page, BURST_CHATS, 0, 'slow fleet gate turn')
    result.midTurnLaunched = await waitForLaunches(stub.launchLog, BURST_CHATS)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  } finally {
    stderrOwnership += first.ownershipText()
    await first.close()
  }
  const stopLoad = startCpuLoad(repoRoot)
  try {
    const second = await copy('restart')
    try {
      const before = countLaunches(stub.launchLog)
      result.continuation = await continueAfterRestart(second.page)
      const expected = result.continuation.offered || BURST_CHATS
      result.continuationLaunched =
        (await waitForLaunches(stub.launchLog, before + expected)) - before
      const coldBefore = countLaunches(stub.launchLog)
      result.cold = await createChatBurst(
        second.page,
        BURST_CHATS,
        BURST_CHATS,
        'fleet gate cold turn'
      )
      result.coldLaunched =
        (await waitForLaunches(stub.launchLog, coldBefore + BURST_CHATS)) - coldBefore
    } finally {
      stderrOwnership += second.ownershipText()
      await second.close()
    }
  } finally {
    stopLoad()
  }
  result.ownershipRefusals = countOwnershipRefusals(stderrOwnership, userDataDir)
  fs.rmSync(runDir, { recursive: true, force: true })
  console.log(`[fleet-gate] ${label}: ${JSON.stringify(result)}`)
  return result
}

/** A seed made by the OLD build, so NEW only ever opens it forward, as an upgrade would. */
async function ensureSeed({ oldSha, oldBuild, outDir }) {
  const seedsDir = path.join(CACHE_ROOT, 'seeds')
  const seedDir = path.join(seedsDir, oldSha)
  const existing = readSeedReceipt(seedDir)
  if (existing) {
    fs.utimesSync(path.join(seedDir, '.fleet-seed.json'), new Date(), new Date())
    return { seedDir, receipt: existing }
  }
  console.log(`[fleet-gate] seeding a synthetic fleet with ${oldSha.slice(0, 12)}`)
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-fleet-seed-'))
  try {
    const receipt = await buildSyntheticFleetSeed({
      seedDir,
      corpusDir: path.join(CACHE_ROOT, 'corpus'),
      builtBy: oldSha,
      launch: (userDataDir) =>
        launchCopy({ buildDir: oldBuild, runDir, userDataDir, label: 'seed', outDir })
    })
    console.log(`[fleet-gate] seed ${JSON.stringify(receipt)}`)
    pruneCache(seedsDir, '.fleet-seed.json', KEEP_SEEDS, new Set([seedDir]))
    return { seedDir, receipt }
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true })
  }
}

async function measureOnce({ arm, sha, buildDir, seedDir, options, runDir, outDir }) {
  const userDataDir = path.join(runDir, 'user-data')
  fs.cpSync(seedDir, userDataDir, { recursive: true, mode: fs.constants.COPYFILE_FICLONE })
  const result = { arm, sha, windows: {}, census: null, notes: [], incomplete: [] }
  const label = `${arm}-${sha.slice(0, 11)}`
  const { app, page, close } = await launchCopy({ buildDir, runDir, userDataDir, label, outDir })
  try {
    const probeState = await installMainProbeIn(app)
    if (probeState === 'installed-without-invoke') {
      result.notes.push(`main probe ${probeState}: R→M counts only send(), not invoke()`)
    }
    const renderer = await installRendererProbe(page)
    if (renderer.breakpoints === 0) {
      result.incomplete.push('store notify loop not found: store pubs/wakeups not measured')
    }
    console.log(`[fleet-gate] ${label} up; settling ${options.settleMs / 1000}s`)
    const agents = await seedAgentStatuses({ page, userDataDir, count: AGENT_PANES })
    if (agents.panes === 0) {
      result.incomplete.push(`no idle agent statuses: ${JSON.stringify(agents)}`)
    } else if (agents.failed > 0) {
      result.notes.push(`agent statuses: ${JSON.stringify(agents)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, options.settleMs))
    result.census = { ...(await readFleetCensus(page)), agentPanes: agents.panes }
    if (options.minWorkspaces && !(result.census.workspaces >= options.minWorkspaces)) {
      result.incomplete.push(
        `fleet loaded ${String(result.census.workspaces)} of ${String(options.minWorkspaces)} workspaces`
      )
    }
    await page.screenshot({ path: path.join(outDir, `${label}-${Date.now()}.png`) }).catch(() => {})
    for (const name of options.scenarios) {
      const windowMs = name === 'idle' ? options.idleWindowMs : options.windowMs
      await resetMainProbe(app)
      await renderer.reset()
      const started = Date.now()
      const driven = await SCENARIOS[name]({ page, userDataDir, windowMs })
      const elapsed = Date.now() - started
      const main = await snapshotMainProbe(app)
      const rendererSnapshot = await renderer.snapshot()
      if (driven.undriven) {
        result.incomplete.push(`${name}: ${driven.undriven}`)
      } else if (driven.needsInbound && main.in.n === 0) {
        result.incomplete.push(`${name}: no input reached the main process`)
      }
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
        `[fleet-gate] ${label} ${name}: ${JSON.stringify(result.windows[name].metrics)} ${driven.note ?? ''} top M→R ${result.windows[name].topOut.join('; ')}`
      )
    }
  } finally {
    await close()
    fs.rmSync(runDir, { recursive: true, force: true })
  }
  return result
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  const newSha = resolveCommit(repoRoot, options.new)
  const oldSha = options.old
    ? resolveCommit(repoRoot, options.old)
    : git(repoRoot, ['merge-base', 'origin/main', newSha])
  const hot = hotPathChanges(oldSha, newSha, repoRoot)
  if (hot.length === 0 && !options.force) {
    console.log('skipped: no hot-path changes')
    return
  }
  if (options.pathsOnly) {
    console.log(`hot-path changes (${hot.length}): ${hot.slice(0, 10).join(', ')}`)
    return
  }
  const outDir = options.out ?? path.join(CACHE_ROOT, 'reports')
  fs.mkdirSync(outDir, { recursive: true })
  virtualDisplay = await startVirtualDisplay()
  const builds = { old: ensureBuild(repoRoot, oldSha), new: ensureBuild(repoRoot, newSha) }
  const seed = options.seed
    ? { seedDir: options.seed, receipt: null }
    : await ensureSeed({ oldSha, oldBuild: builds.old, outDir })
  const shas = { old: oldSha, new: newSha }
  const runs = []
  const schedule = buildCounterbalancedSchedule(options.runs, 'old', 'new')
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-fleet-gate-'))
  const windowScenarios = options.scenarios.filter((name) => name !== 'burst')
  const bursts = []
  try {
    for (const pair of windowScenarios.length > 0 ? schedule : []) {
      for (const arm of pair) {
        runs.push(
          await measureOnce({
            arm,
            sha: shas[arm],
            buildDir: builds[arm],
            seedDir: seed.seedDir,
            options: {
              ...options,
              scenarios: windowScenarios,
              minWorkspaces: seed.receipt ? SEED_SHAPE.worktrees + SEED_SHAPE.folders : 0
            },
            outDir,
            runDir: path.join(runsRoot, `${arm}-${runs.length}`)
          })
        )
      }
    }
    if (options.scenarios.includes('burst')) {
      for (const arm of ['old', 'new']) {
        bursts.push(
          await burstOnce({
            arm,
            sha: shas[arm],
            buildDir: builds[arm],
            seedDir: seed.seedDir,
            outDir,
            repoRoot,
            runDir: path.join(runsRoot, `burst-${arm}`)
          })
        )
      }
    }
  } finally {
    fs.rmSync(runsRoot, { recursive: true, force: true })
  }
  const census = runs.find((entry) => entry.census)?.census
  const rows = [...compareRuns(runs, windowScenarios), ...burstRows(bursts)]
  const notes = [...new Set(runs.flatMap((entry) => entry.notes))]
  const incomplete = [
    ...new Set(runs.flatMap((entry) => entry.incomplete.map((reason) => `${entry.arm} ${reason}`)))
  ]
  for (const name of windowScenarios) {
    const drivenNotes = [
      ...new Set(runs.map((entry) => entry.windows[name]?.driven?.note).filter(Boolean))
    ]
    notes.push(`${name}: ${drivenNotes.join(' / ')}`)
  }
  const header = [
    `FLEET GATE  OLD ${oldSha.slice(0, 11)}  NEW ${newSha.slice(0, 11)}  ${windowScenarios.length > 0 ? `${String(options.runs)} runs each (alternating)` : 'launch burst only'}  ${os.hostname()} ${process.platform} ${virtualDisplay ? 'Xvfb' : 'hidden window, no paint'}`,
    `census (read back after settle): ${census ? `${String(census.workspaces)} workspaces, ${String(census.chatTabs)} chat tabs, ${String(census.terminalTabs)} terminal tabs, ${String(census.agentPanes)} agent panes` : 'n/a'}; seed ${seed.receipt ? `synthetic, built by ${String(seed.receipt.builtBy).slice(0, 11)}` : String(options.seed)}`,
    `hot-path files: ${hot.length}${options.force && hot.length === 0 ? ' (forced)' : ''}`
  ].join('\n')
  const { text, result } = formatTable({ rows, header, notes, incomplete })
  const stem = path.join(
    outDir,
    `fleet-gate-${oldSha.slice(0, 11)}-${newSha.slice(0, 11)}-${Date.now()}`
  )
  fs.writeFileSync(
    `${stem}.json`,
    `${JSON.stringify({ oldSha, newSha, result, hot, census, incomplete, runs, bursts, rows }, null, 2)}\n`
  )
  fs.writeFileSync(`${stem}.txt`, `${text}\n`)
  console.log('=== FLEET GATE TABLE ===')
  console.log(text)
  console.log(`=== END FLEET GATE TABLE === (raw ${stem}.json)`)
  process.exitCode = { PASS: 0, FAIL: 1, INCOMPLETE: 2 }[result]
}

// Exit explicitly: a launched copy's driver handles otherwise keep the process (and its qa-gate slot) alive.
main()
  .catch((error) => {
    console.error(`[fleet-gate] ${error.stack ?? error}`)
    process.exitCode = 2
  })
  .finally(() => {
    virtualDisplay?.stop()
    process.exit()
  })
