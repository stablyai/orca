#!/usr/bin/env node
// Fleet-scale perf gate: OLD vs NEW on a ~1,900-workspace synthetic profile. Usage: docs/readme/fleet-perf-gate.md.
import { _electron as electron } from '@stablyai/playwright-test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { buildCounterbalancedSchedule } from '../measurement/counterbalanced-benchmark-schedule.mjs'
import { CACHE_ROOT, ensureBuild, git, pruneCache, resolveCommit } from './fleet-gate-builds.mjs'
import { lockCacheEntryAsync, releaseHeldLocks } from './fleet-gate-cache-lock.mjs'
import { copyProfile, stopCopyDaemons } from './fleet-gate-copies.mjs'
import {
  createRunDir,
  daemonsGone,
  killLiveNow,
  reapStaleRunDirs,
  hasRecords,
  recordCopyLaunch,
  recordHelperLaunch,
  removeRunDir
} from './fleet-gate-run-dirs.mjs'
import { startVirtualDisplay } from './fleet-gate-display.mjs'
import { waitForAppWindow } from './fleet-gate-app-ready.mjs'
import { parseArgs } from './fleet-gate-args.mjs'
import { hotPathChanges, isHotPath } from './fleet-gate-hot-paths.mjs'
import { installMainProbeIn, resetMainProbe, snapshotMainProbe } from './fleet-gate-main-probe.mjs'
import { installRendererProbe } from './fleet-gate-renderer-probe.mjs'
import { burstRows, compareRuns, formatTable, windowMetrics } from './fleet-gate-report.mjs'
import { chatMemoryOnce, chatMemoryRows } from './fleet-gate-chat-memory.mjs'
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
import {
  closeStartupDialogs,
  pinClassicWorktreeCards,
  SCENARIO_SETUP,
  SCENARIOS,
  seedAgentStatuses
} from './fleet-gate-scenarios.mjs'
import {
  buildSyntheticFleetSeed,
  ensureFleetCorpus,
  readFleetCensus,
  readSeedReceipt,
  SEED_SHAPE
} from './fleet-gate-synthetic-seed.mjs'

const KEEP_SEEDS = 2
// Idle agents spread over this many workspaces; the #42104 report had ~500 keyed statuses on ~1,900 workspaces.
const AGENT_PANES = 200
// Copies and helpers to stop if the gate itself is stopped (a release bot's timeout, Ctrl-C).
const liveCleanups = new Set()
let launchesInFlight = 0
let stopping = false
// One close can take 30 s for the app plus a few seconds per daemon; a stop waits that long, then exits anyway.
const STOP_BUDGET_MS = 60_000

// Hidden windows never paint, so clicks and screenshots stall; on Linux the copy gets its own Xvfb, never a real desktop.
let virtualDisplay = null
// This gate's folder under the cache: every copy, temp file and helper record lives here (see fleet-gate-run-dirs.mjs).
let gateRunDir = null

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
  // Temp files stay in the gate's folder, which the gate (or the next gate's reap) deletes.
  const tmp = path.join(gateRunDir, 'tmp')
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
          'ELECTRON_OZONE_PLATFORM_HINT',
          // Shells would still read the user's own rc files through these, whatever HOME says.
          'ZDOTDIR',
          'BASH_ENV',
          'ENV'
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
    TMPDIR: tmp,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex')
  }
}

/** Stops a copy's daemons and proves them gone; a failed ps never counts, so the copy's record stays. */
async function daemonsStopped(userDataDir) {
  try {
    await stopCopyDaemons(userDataDir)
    return await daemonsGone(userDataDir)
  } catch {
    return false
  }
}

/** Launches one hidden copy on userDataDir; close() quits it (gracefully first) and is safe to call twice. */
async function launchCopy({ buildDir, runDir, userDataDir, label, outDir, extraEnv = {} }) {
  if (stopping) {
    throw new Error('gate is stopping')
  }
  const executablePath = createRequire(path.join(buildDir, 'package.json'))('electron')
  // Counted until its close is registered, so a stop signal waits for a copy that is still starting.
  launchesInFlight += 1
  const launchRecord = recordCopyLaunch(runDir, userDataDir)
  let app
  try {
    app = await electron.launch({
      executablePath,
      args: [launchRecord.arg, ...launchArgs(buildDir)],
      env: { ...isolatedEnv(runDir, userDataDir), ...extraEnv },
      timeout: 180_000
    })
  } catch (error) {
    // Still in flight until its daemons are stopped and its record dropped, so a stop signal waits for it.
    // A failed daemon stop keeps the pending record, so the next gate's reap retries it.
    if (await daemonsStopped(userDataDir)) {
      launchRecord.forget()
    }
    launchesInFlight -= 1
    throw error
  }
  // Captured now: app.process() throws once the app object is closed.
  const child = app.process()
  launchRecord.commit(child.pid)
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
  let closing = null
  // Every caller, including a stop signal arriving mid-close, waits for the same full close.
  const close = () => {
    closing ??= closeOnce()
    return closing
  }
  const closeOnce = async () => {
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 30_000))
    ])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    // A failed daemon stop keeps the record, so the run folder (and the next gate's reap) still knows the daemon.
    if (await daemonsStopped(userDataDir)) {
      launchRecord.forget()
    }
    liveCleanups.delete(close)
  }
  liveCleanups.add(close)
  launchesInFlight -= 1
  try {
    const page = await waitForAppWindow(app, { label, userDataDir, outDir, stderrTail })
    return { app, page, close, ownershipText: () => ownershipText }
  } catch (error) {
    await close()
    throw error
  }
}

/** Quit with chats mid-turn, restart under load and continue them all, then a cold burst: every launch must start. */
async function burstOnce({ arm, sha, buildDir, seedDir, runDir, outDir, repoRoot, minWorkspaces }) {
  const userDataDir = path.join(runDir, 'user-data')
  copyProfile(seedDir, userDataDir)
  const stub = writeClaudeStub(path.join(runDir, 'stub'), repoRoot)
  const extraEnv = {
    PATH: [path.dirname(stub.command), process.env.PATH ?? ''].join(path.delimiter)
  }
  const label = `burst-${arm}-${sha.slice(0, 11)}`
  const copy = (suffix) =>
    launchCopy({ buildDir, runDir, userDataDir, label: `${label}-${suffix}`, outDir, extraEnv })
  const result = { arm, sha, incomplete: [] }
  let stderrOwnership = ''
  const first = await copy('mid-turn')
  try {
    const { workspaces } = await readFleetCensus(first.page)
    if (minWorkspaces && !(workspaces >= minWorkspaces)) {
      result.incomplete.push(
        `burst fleet loaded ${String(workspaces)} of ${String(minWorkspaces)} workspaces`
      )
    }
    await pointClaudeAtStub(first.page, stub.command)
    // The stub keeps a prompt containing "slow" running until interrupted, so these chats quit mid-turn.
    result.midTurn = await createChatBurst(first.page, BURST_CHATS, 0, 'slow fleet gate turn')
    result.midTurnLaunched = await waitForLaunches(stub.launchLog, result.midTurn.sessionIds.length)
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  } finally {
    stderrOwnership += first.ownershipText()
    await first.close()
  }
  const stopLoad = startCpuLoad(repoRoot, recordHelperLaunch(gateRunDir))
  liveCleanups.add(stopLoad)
  try {
    const second = await copy('restart')
    try {
      const before = countLaunches(stub.launchLog)
      result.continuation = await continueAfterRestart(second.page, result.midTurn.sessionIds)
      const expected = result.continuation.offered
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
        (await waitForLaunches(stub.launchLog, coldBefore + result.cold.sessionIds.length)) -
        coldBefore
    } finally {
      stderrOwnership += second.ownershipText()
      await second.close()
    }
  } finally {
    const earlyExits = stopLoad()
    liveCleanups.delete(stopLoad)
    if (earlyExits > 0) {
      result.incomplete.push(
        `${String(earlyExits)} CPU-load worker(s) exited before the burst ended`
      )
    }
  }
  for (const [phase, batch] of [
    ['mid-turn', result.midTurn],
    ['cold', result.cold]
  ]) {
    if (batch?.requested !== BURST_CHATS) {
      result.undersizedPhases = [...(result.undersizedPhases ?? []), phase]
      result.incomplete.push(
        `${phase} burst found ${String(batch?.requested)} of ${String(BURST_CHATS)} workspaces`
      )
    }
  }
  result.ownershipRefusals = countOwnershipRefusals(stderrOwnership, userDataDir)
  removeRunDir(runDir)
  console.log(`[fleet-gate] ${label}: ${JSON.stringify(result)}`)
  return result
}

/** A seed made by the OLD build, so NEW only ever opens it forward, as an upgrade would. */
async function ensureSeed({ oldSha, oldBuild, outDir }) {
  const seedsDir = path.join(CACHE_ROOT, 'seeds')
  const seedDir = path.join(seedsDir, oldSha)
  fs.mkdirSync(seedsDir, { recursive: true })
  const unlock = await lockCacheEntryAsync(seedDir)
  try {
    return await seedUnderLock({ seedsDir, seedDir, oldSha, oldBuild, outDir })
  } finally {
    unlock()
  }
}

async function seedUnderLock({ seedsDir, seedDir, oldSha, oldBuild, outDir }) {
  const existing = readSeedReceipt(seedDir)
  if (existing) {
    fs.utimesSync(path.join(seedDir, '.fleet-seed.json'), new Date(), new Date())
    return { seedDir, receipt: existing }
  }
  console.log(`[fleet-gate] seeding a synthetic fleet with ${oldSha.slice(0, 12)}`)
  const runDir = path.join(gateRunDir, 'seed')
  try {
    const receipt = await buildSyntheticFleetSeed({
      seedDir,
      workDir: path.join(runDir, 'user-data'),
      corpusDir: path.join(CACHE_ROOT, 'corpus'),
      builtBy: oldSha,
      launch: (userDataDir) =>
        launchCopy({ buildDir: oldBuild, runDir, userDataDir, label: 'seed', outDir })
    })
    console.log(`[fleet-gate] seed ${JSON.stringify(receipt)}`)
    pruneCache(seedsDir, '.fleet-seed.json', KEEP_SEEDS, new Set([seedDir]))
    return { seedDir, receipt }
  } finally {
    removeRunDir(runDir)
  }
}

async function measureOnce({ arm, sha, buildDir, seedDir, options, runDir, outDir }) {
  const userDataDir = path.join(runDir, 'user-data')
  copyProfile(seedDir, userDataDir)
  const result = { arm, sha, windows: {}, census: null, notes: [], incomplete: [] }
  const label = `${arm}-${sha.slice(0, 11)}`
  const { app, page, close } = await launchCopy({ buildDir, runDir, userDataDir, label, outDir })
  try {
    const probeState = await installMainProbeIn(app)
    if (probeState === 'installed-without-invoke') {
      result.incomplete.push('main probe could not count invoke(): R→M would miss requests')
    }
    const renderer = await installRendererProbe(page)
    if (renderer.breakpoints === 0) {
      result.incomplete.push('store notify loop not found: store pubs/wakeups not measured')
    }
    console.log(`[fleet-gate] ${label} up; settling ${options.settleMs / 1000}s`)
    // Pinned twice: UI state may still be loading the first time, so only the post-settle result counts.
    await pinClassicWorktreeCards(page)
    const agents = await seedAgentStatuses({ page, userDataDir, count: AGENT_PANES })
    if (agents.panes === 0) {
      result.incomplete.push(`no idle agent statuses: ${JSON.stringify(agents)}`)
    } else if (agents.failed > 0) {
      result.notes.push(`agent statuses: ${JSON.stringify(agents)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, options.settleMs))
    await closeStartupDialogs(page, result.incomplete)
    const cards = await pinClassicWorktreeCards(page)
    if (cards !== 'classic') {
      result.incomplete.push(
        `worktree cards not pinned to classic (${cards}): OLD and NEW would differ`
      )
    }
    result.census = { ...(await readFleetCensus(page)), agentPanes: agents.panes }
    for (const [field, expected] of Object.entries(options.fullFleet ?? {})) {
      if (!(result.census[field] >= expected)) {
        result.incomplete.push(
          `fleet loaded ${String(result.census[field])} of ${String(expected)} ${field}`
        )
      }
    }
    await page.screenshot({ path: path.join(outDir, `${label}-${Date.now()}.png`) }).catch(() => {})
    for (const name of options.scenarios) {
      const windowMs = name === 'idle' ? options.idleWindowMs : options.windowMs
      await SCENARIO_SETUP[name]?.(page)
      await resetMainProbe(app)
      await renderer.reset()
      const started = Date.now()
      const driven = await SCENARIOS[name]({ page, userDataDir, windowMs })
      const elapsed = Date.now() - started
      const main = await snapshotMainProbe(app)
      const rendererSnapshot = await renderer.snapshot()
      // After the snapshot, so a scenario's cleanup (e.g. typing's backspaces) is never measured or counted.
      await driven.cleanup?.()
      const ptyWrites = main.inByChannel['pty:write']?.n ?? 0
      const undriven =
        driven.undriven ??
        (ptyWrites < (driven.ptyWritesNeeded ?? 0)
          ? `${String(ptyWrites)} of ${String(driven.ptyWritesNeeded)} needed keys reached the terminal`
          : null)
      if (undriven) {
        result.incomplete.push(`${name}: ${undriven}`)
      }
      result.windows[name] = {
        driven: { ...driven, cleanup: undefined },
        undriven,
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
    removeRunDir(runDir)
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
  // The two builds' trees, not merge-base semantics: release tags often sit on sibling branches.
  const hot = hotPathChanges(oldSha, newSha, repoRoot, isHotPath, true)
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
  const reaped = await reapStaleRunDirs()
  if (reaped > 0) {
    console.log(`[fleet-gate] reaped ${String(reaped)} run folder(s) a stopped gate left behind`)
  }
  gateRunDir = createRunDir('gate')
  // Synchronous cache work comes first, before stop handlers exist, so a stop signal still ends it at once.
  const builds = { old: ensureBuild(repoRoot, oldSha), new: ensureBuild(repoRoot, newSha) }
  if (!options.seed) {
    ensureFleetCorpus(path.join(CACHE_ROOT, 'corpus'))
  }
  installStopHandlers()
  virtualDisplay = await startVirtualDisplay(recordHelperLaunch(gateRunDir))
  // Its bound is calibrated on Linux only; elsewhere ask for it with --scenarios and read the number.
  const chatMemoryDefault = process.platform === 'linux' ? ['chat-memory'] : []
  // Without a private display copies stay hidden and unpainted, so clicks and focus can't be driven.
  options.scenarios ??= virtualDisplay
    ? [...Object.keys(SCENARIOS), 'burst', ...chatMemoryDefault]
    : ['idle', 'streaming', 'burst', ...chatMemoryDefault]
  const seed = options.seed
    ? { seedDir: options.seed, receipt: null }
    : await ensureSeed({ oldSha, oldBuild: builds.old, outDir })
  const shas = { old: oldSha, new: newSha }
  const runs = []
  const schedule = buildCounterbalancedSchedule(options.runs, 'old', 'new')
  const runsRoot = gateRunDir
  const windowScenarios = options.scenarios.filter(
    (name) => name !== 'burst' && name !== 'chat-memory'
  )
  const bursts = []
  // Each run removes its own copy; the gate's folder (runsRoot) goes when the gate exits.
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
            fullFleet: seed.receipt
              ? {
                  workspaces: SEED_SHAPE.worktrees + SEED_SHAPE.folders,
                  chatTabs: SEED_SHAPE.chats,
                  terminalTabs: SEED_SHAPE.terminals
                }
              : null
          },
          outDir,
          runDir: path.join(runsRoot, `${arm}-${runs.length}`)
        })
      )
    }
  }
  // The burst judges NEW alone, so OLD never pays for a fleet launch under full CPU load.
  if (options.scenarios.includes('burst')) {
    bursts.push(
      await burstOnce({
        arm: 'new',
        sha: shas.new,
        buildDir: builds.new,
        seedDir: seed.seedDir,
        outDir,
        repoRoot,
        minWorkspaces: seed.receipt ? SEED_SHAPE.worktrees + SEED_SHAPE.folders : 0,
        runDir: path.join(runsRoot, 'burst-new')
      })
    )
  }
  // Absolute like the burst, so it runs on NEW only.
  const chatMemory = []
  if (options.scenarios.includes('chat-memory')) {
    // A failed step reports INCOMPLETE instead of losing the windows and burst measured before it.
    chatMemory.push(
      await chatMemoryOnce({
        launchCopy,
        arm: 'new',
        sha: shas.new,
        buildDir: builds.new,
        seedDir: seed.seedDir,
        outDir,
        repoRoot,
        options,
        runDir: path.join(runsRoot, 'chat-memory-new')
      }).catch((error) => ({
        arm: 'new',
        incomplete: [`chat-mem: ${String(error?.message ?? error)}`]
      }))
    )
  }
  const census = runs.find((entry) => entry.census)?.census
  const rows = [
    ...compareRuns(runs, windowScenarios),
    ...burstRows(bursts),
    ...chatMemoryRows(chatMemory)
  ]
  const notes = [...new Set(runs.flatMap((entry) => entry.notes))]
  const incomplete = [
    ...new Set(
      [...runs, ...bursts, ...chatMemory].flatMap((entry) =>
        entry.incomplete.map((reason) => `${String(entry.arm)} ${String(reason)}`)
      )
    )
  ]
  for (const name of windowScenarios) {
    const drivenNotes = [
      ...new Set(runs.map((entry) => entry.windows[name]?.driven?.note).filter(Boolean))
    ]
    notes.push(`${name}: ${drivenNotes.join(' / ')}`)
  }
  const header = [
    `FLEET GATE  OLD ${oldSha.slice(0, 11)}  NEW ${newSha.slice(0, 11)}  ${windowScenarios.length > 0 ? `${String(options.runs)} runs each (alternating)` : 'NEW-only checks'}  ${os.hostname()} ${process.platform} ${virtualDisplay ? 'Xvfb' : 'hidden window, no paint'}`,
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
    `${JSON.stringify({ oldSha, newSha, result, hot, census, incomplete, runs, bursts, chatMemory, rows }, null, 2)}\n`
  )
  fs.writeFileSync(`${stem}.txt`, `${text}\n`)
  console.log('=== FLEET GATE TABLE ===')
  console.log(text)
  console.log(`=== END FLEET GATE TABLE === (raw ${stem}.json)`)
  process.exitCode = { PASS: 0, FAIL: 1, INCOMPLETE: 2 }[result]
}

// Copies still mid-launch register only once up, so keep going until none are left or the budget runs out.
async function stopEverything() {
  const deadline = Date.now() + STOP_BUDGET_MS
  while ((liveCleanups.size > 0 || launchesInFlight > 0) && Date.now() < deadline) {
    await Promise.race([
      Promise.allSettled([...liveCleanups].map((cleanup) => cleanup())),
      new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))
    ])
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** A stopped gate still stops its copies, their daemons, the CPU load and Xvfb, and frees its cache locks. */
function installStopHandlers() {
  // SIGHUP: the terminal or remote session running the gate went away.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      stopping = true
      console.error(`[fleet-gate] ${signal}: stopping copies`)
      void stopEverything().finally(() => {
        virtualDisplay?.stop()
        releaseHeldLocks()
        process.exit(2)
      })
    })
  }
}

// Last resort for any exit path that skipped the graceful closes (a thrown error, a stop signal's process.exit).
process.on('exit', () => {
  killLiveNow()
  // A copy still launching isn't in the live list yet: keep its pending record for the next gate's reap.
  if (gateRunDir && launchesInFlight === 0 && !hasRecords(gateRunDir)) {
    fs.rmSync(gateRunDir, { recursive: true, force: true })
  }
})

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
